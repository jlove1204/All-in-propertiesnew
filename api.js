const {createClient}=require('@supabase/supabase-js');
const Stripe=require('stripe');
const crypto=require('crypto');

const U=process.env.NEXT_PUBLIC_SUPABASE_URL||process.env.SUPABASE_URL;
const K=process.env.SUPABASE_SECRET_KEY;
const P=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY||process.env.SUPABASE_PUBLISHABLE_KEY;
const OWNER_EMAIL=String(process.env.OWNER_ADMIN_EMAIL||'').toLowerCase().trim();
const LIVE_ENABLED=String(process.env.ENABLE_LIVE_CHECKOUT||'').toLowerCase()==='true';
const LIVE_KEY=process.env.STRIPE_SECRET_KEY||'';
const TEST_KEY=process.env.STRIPE_TEST_SECRET_KEY||'';
const TERMS_VERSION='2026-09-v6';
const PRIVACY_VERSION='2026-09-v6';
const BOOKING_TERMS_VERSION='2026-09-v6';
const IDENTITY_DISCLOSURE_VERSION='2026-09-v6';
const ECOMM_VERSION='2026-09-v6';
const RESEND_KEY=process.env.RESEND_API_KEY||'';
const FROM_EMAIL=process.env.FROM_EMAIL||'';

const PUBLIC_PROPERTY_FIELDS=[
  'id','name','slug','description','location','general_area','general_area_description',
  'nightly_rate','cleaning_fee','tax_rate','max_guests','bedrooms','bathrooms','active',
  'created_at','updated_at','image_urls','minimum_nights','amenities','house_rules',
  'check_in_time','check_out_time','featured','cancellation_policy',
  'pets_allowed','smoking_allowed','parties_allowed'
].join(',');

const PRIVATE_FIELDS=['address_line1','address_line2','city','state_region','postal_code',
  'arrival_instructions','parking_instructions','wifi_name','wifi_password',
  'access_instructions','checkout_instructions','directions_notes','emergency_contact'];

function stripeKey(){
  if(LIVE_ENABLED){
    if(LIVE_KEY.startsWith('sk_live_'))return LIVE_KEY;
    if(LIVE_KEY.startsWith('sk_test_'))return LIVE_KEY;
    return '';
  }
  if(TEST_KEY.startsWith('sk_test_'))return TEST_KEY;
  if(LIVE_KEY.startsWith('sk_test_'))return LIVE_KEY;
  return '';
}
function stripeMode(){const k=stripeKey();return k.startsWith('sk_live_')?'live':k.startsWith('sk_test_')?'test':'none'}
function out(res,status,data){res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store, max-age=0');res.end(JSON.stringify(data))}
function path(req){try{return new URL(req.url,'http://x').pathname}catch{return req.url||'/'}}
async function body(req){
  if(req.body&&Buffer.isBuffer(req.body))return JSON.parse(req.body.toString('utf8')||'{}');
  if(req.body&&typeof req.body==='object')return req.body;
  if(typeof req.body==='string')return JSON.parse(req.body||'{}');
  let s='';for await(const c of req)s+=c;
  if(s.length>1000000){let e=Error('Request too large.');e.status=413;throw e}
  return JSON.parse(s||'{}');
}
function db(){if(!U||!K){let e=Error('Supabase server configuration is missing.');e.status=503;throw e}return createClient(U,K,{auth:{persistSession:false,autoRefreshToken:false}})}
function base(req){return`${req.headers['x-forwarded-proto']||'https'}://${req.headers['x-forwarded-host']||req.headers.host}`}
function txt(v,max=4000){v=String(v??'').trim();return v?v.slice(0,max):null}
function bool(v){return v===true||v==='true'||v===1||v==='1'}
function dateOK(v){return/^\d{4}-\d{2}-\d{2}$/.test(String(v||''))&&!Number.isNaN(Date.parse(v+'T00:00:00Z'))}
function today(){return new Date().toISOString().slice(0,10)}
function nights(a,b){const x=Date.parse(a+'T00:00:00Z'),y=Date.parse(b+'T00:00:00Z');return Number.isFinite(x)&&Number.isFinite(y)?Math.round((y-x)/86400000):NaN}
function emailOK(v){return/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v||'').trim())}
function reqCode(){return'REQ-'+crypto.randomBytes(4).toString('hex').toUpperCase()}
function ageFromDOB(v){if(!dateOK(v))return null;const d=new Date(v+'T00:00:00Z'),n=new Date();let a=n.getUTCFullYear()-d.getUTCFullYear();const md=n.getUTCMonth()-d.getUTCMonth();if(md<0||(md===0&&n.getUTCDate()<d.getUTCDate()))a--;return a}

function cleanPublic(b){
  const x={};
  for(const k of ['name','location','general_area','general_area_description','description','house_rules','check_in_time','check_out_time','cancellation_policy'])
    if(k in b)x[k]=txt(b[k],['description','general_area_description','cancellation_policy'].includes(k)?4000:500);
  for(const k of ['nightly_rate','cleaning_fee','tax_rate','max_guests','bedrooms','bathrooms','minimum_nights'])
    if(k in b)x[k]=b[k]===null||b[k]===''?null:Number(b[k]);
  for(const k of ['active','featured','pets_allowed','smoking_allowed','parties_allowed'])if(k in b)x[k]=bool(b[k]);
  if('image_urls'in b)x.image_urls=Array.isArray(b.image_urls)?b.image_urls.filter(v=>typeof v==='string'&&/^https:\/\//i.test(v)).slice(0,12):[];
  if('amenities'in b)x.amenities=Array.isArray(b.amenities)?[...new Set(b.amenities.map(v=>String(v).trim()).filter(Boolean))].slice(0,50):[];
  return x;
}
function cleanPrivate(b){const x={};for(const k of PRIVATE_FIELDS)if(k in b)x[k]=txt(b[k],4000);return x}
function validateProperty(x){
  if(!x.name)return'Property name is required.';
  if(!Number.isFinite(Number(x.nightly_rate))||Number(x.nightly_rate)<0)return'Enter a valid nightly rate.';
  if(x.cleaning_fee!=null&&(!Number.isFinite(Number(x.cleaning_fee))||Number(x.cleaning_fee)<0))return'Enter a valid cleaning fee.';
  if(x.tax_rate!=null&&(!Number.isFinite(Number(x.tax_rate))||Number(x.tax_rate)<0||Number(x.tax_rate)>1))return'Tax rate must be between 0% and 100%.';
  if(!Number.isInteger(Number(x.max_guests))||Number(x.max_guests)<1)return'Maximum guests must be at least 1.';
  if(x.minimum_nights!=null&&(!Number.isInteger(Number(x.minimum_nights))||Number(x.minimum_nights)<1))return'Minimum nights must be at least 1.';
  return null;
}
async function ownerAuth(req,c){
  if(!OWNER_EMAIL){let e=Error('OWNER_ADMIN_EMAIL is not configured.');e.status=503;throw e}
  const h=req.headers.authorization||'',t=h.startsWith('Bearer ')?h.slice(7):'';
  const {data,error}=await c.auth.getUser(t),email=String(data?.user?.email||'').toLowerCase().trim();
  if(error||!data?.user){let e=Error('Please sign in again.');e.status=401;throw e}
  if(email!==OWNER_EMAIL){let e=Error('This account is not authorized.');e.status=403;throw e}
  return data.user;
}
async function userAuth(req,c){
  const h=req.headers.authorization||'',t=h.startsWith('Bearer ')?h.slice(7):'';
  const {data,error}=await c.auth.getUser(t);
  if(error||!data?.user){let e=Error('Sign in to your guest account to continue.');e.status=401;throw e}
  return {user:data.user,token:t};
}
async function profile(c,userId){
  const {data,error}=await c.from('guest_profiles').select('*').eq('user_id',userId).maybeSingle();
  if(error)throw error;return data||null;
}
async function phoneFactorVerified(c,userId){
  try{
    const {data,error}=await c.auth.admin.mfa.listFactors({userId});
    if(error)return false;
    const factors=[];
    const visit=v=>{
      if(!v)return;
      if(Array.isArray(v)){for(const x of v)visit(x);return}
      if(typeof v==='object'){
        if(('factor_type'in v||'type'in v)&&('status'in v||'phone'in v))factors.push(v);
        for(const x of Object.values(v))if(x&&typeof x==='object')visit(x);
      }
    };
    visit(data);
    return factors.some(f=>String(f.factor_type||f.type||'').toLowerCase()==='phone'&&['verified','active'].includes(String(f.status||'').toLowerCase()));
  }catch{return false}
}
async function readiness(c,user){
  let p=await profile(c,user.id);
  const phoneVerified=await phoneFactorVerified(c,user.id);
  if(p&&p.phone_verified!==phoneVerified){await c.from('guest_profiles').update({phone_verified:phoneVerified}).eq('user_id',user.id);p={...p,phone_verified:phoneVerified}}
  const required=['legal_first_name','legal_last_name','date_of_birth','phone','address_line1','city','state_region','postal_code','country_code'];
  const profileComplete=!!p&&required.every(k=>String(p[k]??'').trim());
  const age=p?.date_of_birth?ageFromDOB(p.date_of_birth):null;
  const emailVerified=!!user.email_confirmed_at;
  const identityVerified=p?.identity_status==='verified';
  const active=p?.account_status!=='suspended'&&p?.account_status!=='closed';
  return {profile:p,emailVerified,phoneVerified,identityVerified,profileComplete,age,ageEligible:age!==null&&age>=18,active,
    ready:!!(profileComplete&&emailVerified&&phoneVerified&&identityVerified&&age!==null&&age>=18&&active)};
}
async function propertyById(c,id,activeOnly=true){
  if(!/^[0-9a-f-]{36}$/i.test(String(id||'')))return null;
  let q=c.from('properties').select(PUBLIC_PROPERTY_FIELDS).eq('id',id);if(activeOnly)q=q.eq('active',true);
  const {data,error}=await q.maybeSingle();if(error)throw error;return data||null;
}
async function privateFor(c,propertyId){
  const {data,error}=await c.from('property_private_details').select('*').eq('property_id',propertyId).maybeSingle();
  if(error)throw error;return data||{};
}
async function expireStale(c){
  const now=new Date().toISOString();
  await c.from('reservations').update({status:'cancelled',cancelled_at:now,cancellation_reason:'Payment window expired'}).eq('status','pending').lt('hold_expires_at',now);
  await c.from('booking_requests').update({status:'expired'}).eq('status','approved').lt('approved_until',now);
}
async function availability(c,id,ci,co,g){
  await expireStale(c);
  if(!dateOK(ci)||!dateOK(co))return{available:false,error:'Choose valid check-in and check-out dates.'};
  if(ci<today())return{available:false,error:'Check-in cannot be in the past.'};
  const n=nights(ci,co);if(!Number.isInteger(n)||n<1||n>60)return{available:false,error:'Stay length must be between 1 and 60 nights.'};
  const p=await propertyById(c,id,true);if(!p)return{available:false,error:'Property not found or not published.'};
  if(n<Number(p.minimum_nights||1))return{available:false,error:`This property requires at least ${p.minimum_nights||1} night${Number(p.minimum_nights||1)===1?'':'s'}.`};
  g=Number(g);if(!Number.isInteger(g)||g<1)return{available:false,error:'Guest count must be at least 1.'};
  if(g>Number(p.max_guests||1))return{available:false,error:`This property allows up to ${p.max_guests} guests.`};
  const {data:bl,error:be}=await c.from('blocked_dates').select('id').eq('property_id',id).lt('start_date',co).gt('end_date',ci).limit(1);if(be)throw be;if(bl?.length)return{available:false,error:'Those dates are blocked.'};
  const {data:rs,error:re}=await c.from('reservations').select('id,status,created_at,hold_expires_at').eq('property_id',id).lt('check_in',co).gt('check_out',ci).in('status',['confirmed','paid','pending']);if(re)throw re;
  const now=Date.now();
  if((rs||[]).some(r=>r.status!=='pending'||Date.parse(r.hold_expires_at||new Date(Date.parse(r.created_at)+30*60*1000).toISOString())>now))return{available:false,error:'Those dates are already reserved or held for an approved guest.'};
  return{available:true,property:p,nights:n};
}
function quoteFrom(a){
  const p=a.property,n=a.nights,nightlyRate=Number(p.nightly_rate||0),nightlySubtotal=Math.round(nightlyRate*n*100)/100,cleaningFee=Number(p.cleaning_fee||0),taxRate=Number(p.tax_rate||0),taxes=Math.round((nightlySubtotal+cleaningFee)*taxRate*100)/100,total=Math.round((nightlySubtotal+cleaningFee+taxes)*100)/100;
  return{nights:n,nightlyRate,nightlySubtotal,cleaningFee,taxRate,taxes,total};
}
function maskEmail(e){const [a,b]=String(e||'').split('@');if(!b)return'';return`${a.slice(0,1)}***@${b}`}
function maskPhone(p){p=String(p||'');return p.length>4?'***-***-'+p.slice(-4):'Verified phone'}
async function sendEmail(to,subject,html){
  if(!RESEND_KEY||!FROM_EMAIL||!to)return;
  try{await fetch('https://api.resend.com/emails',{method:'POST',headers:{authorization:`Bearer ${RESEND_KEY}`,'content-type':'application/json'},body:JSON.stringify({from:FROM_EMAIL,to:[to],subject,html})})}catch(e){console.error('email',e.message)}
}
async function addConsents(c,userId){
  const docs=[
    ['terms',TERMS_VERSION],['privacy',PRIVACY_VERSION],['booking_terms',BOOKING_TERMS_VERSION],
    ['identity_disclosure',IDENTITY_DISCLOSURE_VERSION],['electronic_communications',ECOMM_VERSION]
  ];
  const rows=docs.map(([document_type,document_version])=>({user_id:userId,document_type,document_version}));
  const {error}=await c.from('legal_consents').upsert(rows,{onConflict:'user_id,document_type,document_version',ignoreDuplicates:true});
  if(error)throw error;
}
async function requestThread(c,requestId,viewer){
  const {data,error}=await c.from('booking_request_messages').select('id,sender,body,created_at').eq('booking_request_id',requestId).order('created_at');if(error)throw error;
  const col=viewer==='owner'?'read_by_owner_at':'read_by_guest_at';await c.from('booking_request_messages').update({[col]:new Date().toISOString()}).eq('booking_request_id',requestId).is(col,null);
  return data||[];
}
async function reservationThread(c,reservationId,viewer){
  const {data,error}=await c.from('reservation_messages').select('id,sender,body,created_at').eq('reservation_id',reservationId).order('created_at');if(error)throw error;
  const col=viewer==='owner'?'read_by_owner_at':'read_by_guest_at';await c.from('reservation_messages').update({[col]:new Date().toISOString()}).eq('reservation_id',reservationId).is(col,null);
  return data||[];
}
async function confirmStripeSession(c,session){
  if(!session||session.payment_status!=='paid')return{confirmed:false};
  const rid=session.metadata?.reservation_id,requestId=session.metadata?.booking_request_id,confirmation=session.metadata?.confirmation_code;
  if(!rid)return{confirmed:false};
  const pi=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id;
  const {error}=await c.from('reservations').update({status:'confirmed',stripe_payment_intent_id:pi||null,hold_expires_at:null}).eq('id',rid);if(error)throw error;
  if(requestId)await c.from('booking_requests').update({status:'paid',updated_at:new Date().toISOString()}).eq('id',requestId);
  if(pi){
    const {error:pe}=await c.from('payments').upsert({reservation_id:rid,stripe_payment_intent_id:pi,amount:Number(session.amount_total||0)/100,currency:session.currency||'usd',status:'paid'},{onConflict:'stripe_payment_intent_id'});if(pe)throw pe;
  }
  return{confirmed:true,reservationId:rid,confirmationCode:confirmation||null};
}
async function adminReservationDetail(c,id){
  const {data:r,error}=await c.from('reservations').select('*').eq('id',id).maybeSingle();if(error)throw error;if(!r){let e=Error('Reservation not found.');e.status=404;throw e}
  const p=await propertyById(c,r.property_id,false),pv=await privateFor(c,r.property_id);
  const exact=[pv.address_line1,pv.address_line2,pv.city,pv.state_region,pv.postal_code].filter(Boolean).join(', ');
  return{reservation:r,property:p,private:{...pv,exact_address:exact}};
}

module.exports=async(req,res)=>{
  const p=path(req);let c;
  try{
    c=db();

    if(p==='/api/health'&&req.method==='GET')return out(res,200,{ok:true});
    if(p==='/api/config'&&req.method==='GET')return out(res,200,{supabaseUrl:U,supabasePublishableKey:P,termsVersion:TERMS_VERSION,privacyVersion:PRIVACY_VERSION});

    if(p==='/api/properties'&&req.method==='GET'){
      const {data,error}=await c.from('properties').select(PUBLIC_PROPERTY_FIELDS).eq('active',true).order('featured',{ascending:false}).order('created_at',{ascending:true});if(error)throw error;return out(res,200,{properties:data||[]});
    }
    if(p==='/api/availability'&&req.method==='GET'){
      const u=new URL(req.url,'http://x'),r=await availability(c,u.searchParams.get('propertyId'),u.searchParams.get('checkIn'),u.searchParams.get('checkOut'),Number(u.searchParams.get('guests')||1));return out(res,200,r);
    }
    if(p==='/api/quote'&&req.method==='GET'){
      const u=new URL(req.url,'http://x'),a=await availability(c,u.searchParams.get('propertyId'),u.searchParams.get('checkIn'),u.searchParams.get('checkOut'),Number(u.searchParams.get('guests')||1));if(!a.available)return out(res,409,{error:a.error});return out(res,200,quoteFrom(a));
    }

    // ---------- Guest account ----------
    if(p==='/api/account/me'&&req.method==='GET'){
      const {user}=await userAuth(req,c),r=await readiness(c,user);
      return out(res,200,{email:user.email,emailVerified:r.emailVerified,phoneVerified:r.phoneVerified,profile:r.profile,readiness:r,identityEnabled:!!stripeKey(),termsVersion:TERMS_VERSION,privacyVersion:PRIVACY_VERSION});
    }
    if(p==='/api/account/profile'&&req.method==='PATCH'){
      const {user}=await userAuth(req,c),b=await body(req),current=await profile(c,user.id);
      const allowed=['legal_first_name','legal_last_name','preferred_name','date_of_birth','phone','address_line1','address_line2','city','state_region','postal_code','country_code','marketing_opt_in'],x={user_id:user.id};
      for(const k of allowed)if(k in b)x[k]=k==='marketing_opt_in'?bool(b[k]):txt(b[k],k==='address_line1'||k==='address_line2'?300:150);
      if('date_of_birth'in x&&!dateOK(x.date_of_birth))return out(res,400,{error:'Enter a valid date of birth.'});
      if(x.date_of_birth&&ageFromDOB(x.date_of_birth)<18)return out(res,400,{error:'The booking account holder must be at least 18 years old.'});
      if(x.phone&&current?.phone&&x.phone!==current.phone)x.phone_verified=false;
      const {data,error}=await c.from('guest_profiles').upsert(x).select('*').single();if(error)throw error;return out(res,200,{profile:data});
    }
    if(p==='/api/account/phone-status'&&req.method==='POST'){
      const {user}=await userAuth(req,c),verified=await phoneFactorVerified(c,user.id);await c.from('guest_profiles').upsert({user_id:user.id,phone_verified:verified});
      return out(res,200,{phoneVerified:verified});
    }
    if(p==='/api/account/identity/start'&&req.method==='POST'){
      const {user}=await userAuth(req,c),r=await readiness(c,user),sk=stripeKey();
      if(!sk)return out(res,503,{error:'Identity verification is not available until Stripe Identity is enabled for this account.'});
      if(!r.profileComplete)return out(res,400,{error:'Complete your legal name, date of birth, phone number, and home address first.'});
      if(!r.ageEligible)return out(res,403,{error:'The booking account holder must be at least 18 years old.'});
      const st=new Stripe(sk);let session=null;
      if(r.profile?.stripe_identity_session_id){
        try{session=await st.identity.verificationSessions.retrieve(r.profile.stripe_identity_session_id)}catch{}
        if(session?.status==='verified'){await c.from('guest_profiles').update({identity_status:'verified',identity_verified_at:new Date().toISOString(),identity_last_error:null}).eq('user_id',user.id);return out(res,200,{verified:true})}
      }
      if(!session||['canceled'].includes(session.status)){
        session=await st.identity.verificationSessions.create({
          type:'document',
          client_reference_id:user.id,
          provided_details:{email:user.email},
          metadata:{user_id:user.id},
          return_url:`${base(req)}/guest?identity=return`
        },{idempotencyKey:`identity-${user.id}-${Date.now().toString().slice(0,-5)}`});
      }
      await c.from('guest_profiles').update({stripe_identity_session_id:session.id,identity_status:session.status==='verified'?'verified':'pending',identity_last_error:null}).eq('user_id',user.id);
      return out(res,200,{url:session.url,verified:session.status==='verified'});
    }
    if(p==='/api/account/identity/status'&&req.method==='GET'){
      const {user}=await userAuth(req,c),r=await readiness(c,user),sk=stripeKey();let status=r.profile?.identity_status||'unverified',lastError=r.profile?.identity_last_error||null;
      if(sk&&r.profile?.stripe_identity_session_id){
        try{
          const st=new Stripe(sk),s=await st.identity.verificationSessions.retrieve(r.profile.stripe_identity_session_id);status=s.status==='verified'?'verified':s.status==='requires_input'?'requires_input':s.status==='processing'?'pending':status;lastError=s.last_error?.reason||s.last_error?.code||null;
          await c.from('guest_profiles').update({identity_status:status,identity_verified_at:status==='verified'?new Date().toISOString():r.profile?.identity_verified_at||null,identity_last_error:lastError}).eq('user_id',user.id);
        }catch{}
      }
      return out(res,200,{status,lastError});
    }

    if(p==='/api/account/booking-requests'&&req.method==='GET'){
      const {user}=await userAuth(req,c);await expireStale(c);
      const {data,error}=await c.from('booking_requests').select('id,request_code,property_id,check_in,check_out,guests,message_to_host,nightly_subtotal,cleaning_fee,taxes,total_amount,status,owner_decision_message,requested_at,reviewed_at,approved_until,reservation_id,properties(name,general_area,image_urls)').eq('user_id',user.id).order('created_at',{ascending:false});if(error)throw error;
      return out(res,200,{requests:data||[]});
    }
    if(p==='/api/account/booking-requests'&&req.method==='POST'){
      const {user}=await userAuth(req,c),b=await body(req),r=await readiness(c,user);
      if(!r.active)return out(res,403,{error:'This account is not eligible to submit booking requests.'});
      if(!r.emailVerified)return out(res,403,{error:'Confirm your email address before requesting a booking.'});
      if(!r.profileComplete)return out(res,403,{error:'Complete your guest profile before requesting a booking.'});
      if(!r.phoneVerified)return out(res,403,{error:'Verify your mobile phone before requesting a booking.'});
      if(!r.identityVerified)return out(res,403,{error:'Complete government-ID verification before requesting a booking.'});
      if(!r.ageEligible)return out(res,403,{error:'The booking account holder must be at least 18 years old.'});
      if(!(bool(b.acceptTerms)&&bool(b.acceptPrivacy)&&bool(b.acceptBookingTerms)&&bool(b.acceptIdentity)&&bool(b.acceptEcomm)))return out(res,400,{error:'You must affirmatively accept all required legal terms before submitting the request.'});
      const a=await availability(c,b.propertyId,b.checkIn,b.checkOut,Number(b.guests||1));if(!a.available)return out(res,409,{error:a.error});
      const {count,error:ce}=await c.from('booking_requests').select('id',{count:'exact',head:true}).eq('user_id',user.id).gte('requested_at',new Date(Date.now()-24*3600*1000).toISOString());if(ce)throw ce;if((count||0)>=10)return out(res,429,{error:'Too many booking requests were submitted from this account today.'});
      const {data:dupe,error:de}=await c.from('booking_requests').select('id').eq('user_id',user.id).eq('property_id',b.propertyId).eq('check_in',b.checkIn).eq('check_out',b.checkOut).in('status',['requested','approved']).limit(1);if(de)throw de;if(dupe?.length)return out(res,409,{error:'You already have an open request for these dates.'});
      const q=quoteFrom(a),row={request_code:reqCode(),user_id:user.id,property_id:b.propertyId,check_in:b.checkIn,check_out:b.checkOut,guests:Number(b.guests||1),message_to_host:txt(b.messageToHost,2000),nightly_subtotal:q.nightlySubtotal,cleaning_fee:q.cleaningFee,taxes:q.taxes,total_amount:q.total};
      const {data,error}=await c.from('booking_requests').insert(row).select('id,request_code,status,total_amount').single();if(error)throw error;
      await addConsents(c,user.id);
      if(row.message_to_host)await c.from('booking_request_messages').insert({booking_request_id:data.id,sender:'guest',body:row.message_to_host,read_by_guest_at:new Date().toISOString()});
      sendEmail(OWNER_EMAIL,`New booking request ${data.request_code}`,`<p>A verified guest submitted a booking request for <b>${a.property.name}</b>.</p><p>Dates: ${b.checkIn} to ${b.checkOut}</p><p>Open the Owner Dashboard to review it.</p>`);
      return out(res,201,{request:data});
    }
    if(p==='/api/account/request-messages'&&req.method==='GET'){
      const {user}=await userAuth(req,c),u=new URL(req.url,'http://x'),id=u.searchParams.get('requestId');const {data:r,error}=await c.from('booking_requests').select('id').eq('id',id).eq('user_id',user.id).maybeSingle();if(error)throw error;if(!r)return out(res,404,{error:'Booking request not found.'});return out(res,200,{messages:await requestThread(c,id,'guest')});
    }
    if(p==='/api/account/request-messages'&&req.method==='POST'){
      const {user}=await userAuth(req,c),b=await body(req),id=String(b.requestId||''),message=txt(b.message,2000);if(!message)return out(res,400,{error:'Write a message first.'});
      const {data:r,error}=await c.from('booking_requests').select('id').eq('id',id).eq('user_id',user.id).maybeSingle();if(error)throw error;if(!r)return out(res,404,{error:'Booking request not found.'});
      const {count}=await c.from('booking_request_messages').select('id',{count:'exact',head:true}).eq('booking_request_id',id).eq('sender','guest').gte('created_at',new Date(Date.now()-3600000).toISOString());if((count||0)>=20)return out(res,429,{error:'Please wait before sending more messages.'});
      const {data,error:me}=await c.from('booking_request_messages').insert({booking_request_id:id,sender:'guest',body:message,read_by_guest_at:new Date().toISOString()}).select('id,sender,body,created_at').single();if(me)throw me;return out(res,201,{message:data});
    }

    if(p==='/api/account/reservations'&&req.method==='GET'){
      const {user}=await userAuth(req,c);await expireStale(c);
      const {data,error}=await c.from('reservations').select('id,confirmation_code,property_id,booking_request_id,check_in,check_out,guests,total_amount,status,hold_expires_at,created_at,properties(name,general_area,image_urls)').eq('guest_user_id',user.id).order('created_at',{ascending:false});if(error)throw error;return out(res,200,{reservations:data||[]});
    }
    let ar=p.match(/^\/api\/account\/reservations\/([0-9a-f-]+)$/i);
    if(ar&&req.method==='GET'){
      const {user}=await userAuth(req,c);const {data:r,error}=await c.from('reservations').select('*').eq('id',ar[1]).eq('guest_user_id',user.id).maybeSingle();if(error)throw error;if(!r)return out(res,404,{error:'Reservation not found.'});
      const prop=await propertyById(c,r.property_id,false);let priv={};if(['confirmed','paid'].includes(r.status)){priv=await privateFor(c,r.property_id);priv.exact_address=[priv.address_line1,priv.address_line2,priv.city,priv.state_region,priv.postal_code].filter(Boolean).join(', ')}
      return out(res,200,{reservation:r,property:prop,private:priv});
    }
    if(p==='/api/account/reservation-messages'&&req.method==='GET'){
      const {user}=await userAuth(req,c),u=new URL(req.url,'http://x'),id=u.searchParams.get('reservationId');const {data:r,error}=await c.from('reservations').select('id,status').eq('id',id).eq('guest_user_id',user.id).maybeSingle();if(error)throw error;if(!r||!['confirmed','paid'].includes(r.status))return out(res,404,{error:'Confirmed reservation not found.'});return out(res,200,{messages:await reservationThread(c,id,'guest')});
    }
    if(p==='/api/account/reservation-messages'&&req.method==='POST'){
      const {user}=await userAuth(req,c),b=await body(req),id=String(b.reservationId||''),message=txt(b.message,2000);if(!message)return out(res,400,{error:'Write a message first.'});
      const {data:r,error}=await c.from('reservations').select('id,status').eq('id',id).eq('guest_user_id',user.id).maybeSingle();if(error)throw error;if(!r||!['confirmed','paid'].includes(r.status))return out(res,404,{error:'Confirmed reservation not found.'});
      const {data,error:me}=await c.from('reservation_messages').insert({reservation_id:id,sender:'guest',body:message,read_by_guest_at:new Date().toISOString()}).select('id,sender,body,created_at').single();if(me)throw me;return out(res,201,{message:data});
    }

    if(p==='/api/account/create-checkout'&&req.method==='POST'){
      const {user}=await userAuth(req,c),b=await body(req),requestId=String(b.requestId||''),sk=stripeKey();if(!sk)return out(res,503,{error:'Payments are not available while Stripe setup is being completed.'});await expireStale(c);
      const {data:r,error}=await c.from('booking_requests').select('*,properties(name)').eq('id',requestId).eq('user_id',user.id).maybeSingle();if(error)throw error;if(!r)return out(res,404,{error:'Booking request not found.'});if(r.status!=='approved'||!r.reservation_id)return out(res,409,{error:'This request is not currently approved for payment.'});if(!r.approved_until||Date.parse(r.approved_until)<=Date.now())return out(res,409,{error:'The payment window has expired. Ask the owner to review the request again.'});
      const {data:rv,error:re}=await c.from('reservations').select('*').eq('id',r.reservation_id).eq('guest_user_id',user.id).maybeSingle();if(re)throw re;if(!rv||rv.status!=='pending')return out(res,409,{error:'This reservation is no longer awaiting payment.'});
      const st=new Stripe(sk),session=await st.checkout.sessions.create({
        mode:'payment',customer_email:user.email,expires_at:Math.min(Math.floor(Date.parse(r.approved_until)/1000),Math.floor(Date.now()/1000)+86400),
        line_items:[{quantity:1,price_data:{currency:'usd',unit_amount:Math.round(Number(r.total_amount)*100),product_data:{name:`${r.properties?.name||'All In Properties stay'}`,description:`${r.check_in} to ${r.check_out} · approved booking request`}}}],
        metadata:{reservation_id:rv.id,booking_request_id:r.id,confirmation_code:rv.confirmation_code,property_id:r.property_id,user_id:user.id},
        success_url:`${base(req)}/guest?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:`${base(req)}/guest?checkout=cancelled`
      },{idempotencyKey:`approved-request-${r.id}`});
      await c.from('reservations').update({stripe_checkout_session_id:session.id}).eq('id',rv.id);return out(res,200,{url:session.url});
    }
    if(p==='/api/account/finalize'&&req.method==='GET'){
      const {user}=await userAuth(req,c),u=new URL(req.url,'http://x'),sid=u.searchParams.get('session_id'),sk=stripeKey();if(!sk)return out(res,503,{error:'Stripe is not configured.'});if(!sid)return out(res,400,{error:'Missing checkout session.'});
      const st=new Stripe(sk),session=await st.checkout.sessions.retrieve(sid);if(session.metadata?.user_id&&session.metadata.user_id!==user.id)return out(res,403,{error:'This checkout does not belong to your account.'});
      const result=await confirmStripeSession(c,session);return out(res,200,result);
    }
    if(p==='/api/account/export'&&req.method==='GET'){
      const {user}=await userAuth(req,c),p0=await profile(c,user.id);
      const [consents,requests,reservations]=await Promise.all([
        c.from('legal_consents').select('*').eq('user_id',user.id),
        c.from('booking_requests').select('*').eq('user_id',user.id),
        c.from('reservations').select('*').eq('guest_user_id',user.id)
      ]);
      return out(res,200,{exportedAt:new Date().toISOString(),account:{id:user.id,email:user.email,emailConfirmedAt:user.email_confirmed_at},profile:p0,legalConsents:consents.data||[],bookingRequests:requests.data||[],reservations:reservations.data||[]});
    }
    if(p==='/api/account/delete-request'&&req.method==='POST'){
      const {user}=await userAuth(req,c);await c.from('guest_profiles').upsert({user_id:user.id,deletion_requested_at:new Date().toISOString()});sendEmail(OWNER_EMAIL,'Guest privacy request',`<p>A guest account requested deletion/privacy review.</p><p>User ID: ${user.id}</p>`);return out(res,200,{ok:true,message:'Your deletion request was recorded. Records that must be retained for tax, fraud-prevention, chargeback, or legal obligations may be retained as permitted by law.'});
    }

    // ---------- Owner ----------
    if(p==='/api/admin/me'&&req.method==='GET'){const u=await ownerAuth(req,c);return out(res,200,{email:u.email})}
    if(p==='/api/admin/health'&&req.method==='GET'){
      await ownerAuth(req,c);let database=false,storage=false,accounts=false;try{database=!(await c.from('properties').select('id').limit(1)).error}catch{}try{storage=!(await c.storage.getBucket('property-images')).error}catch{}try{accounts=!(await c.from('booking_requests').select('id').limit(1)).error}catch{}
      return out(res,200,{database,storage,accounts,identityAvailable:!!stripeKey(),stripeMode:stripeMode(),liveCheckoutEnabled:LIVE_ENABLED&&stripeMode()==='live',webhookConfigured:!!(process.env.STRIPE_WEBHOOK_SECRET||process.env.STRIPE_TEST_WEBHOOK_SECRET),transactionalEmailConfigured:!!(RESEND_KEY&&FROM_EMAIL)});
    }
    if(p==='/api/admin/photo-upload-url'&&req.method==='POST'){
      await ownerAuth(req,c);const b=await body(req),mime=String(b.contentType||'image/jpeg').toLowerCase();if(!mime.startsWith('image/'))return out(res,400,{error:'Please choose an image file.'});let ext=(String(b.filename||'photo.jpg').split('.').pop()||'jpg').toLowerCase().replace(/[^a-z0-9]/g,'');if(!['jpg','jpeg','png','webp','heic','heif'].includes(ext))ext='jpg';const storagePath=`properties/${Date.now()}-${crypto.randomUUID()}.${ext}`,{data,error}=await c.storage.from('property-images').createSignedUploadUrl(storagePath,{upsert:false});if(error)throw error;const {data:pub}=c.storage.from('property-images').getPublicUrl(storagePath);return out(res,200,{path:data.path||storagePath,token:data.token,publicUrl:pub.publicUrl});
    }
    if(p==='/api/admin/photo-delete'&&req.method==='POST'){
      await ownerAuth(req,c);const b=await body(req),url=String(b.url||''),marker='/storage/v1/object/public/property-images/';let i=url.indexOf(marker);if(i<0)return out(res,400,{error:'Invalid property photo URL.'});let sp=decodeURIComponent(url.slice(i+marker.length).split('?')[0]);if(!sp.startsWith('properties/'))return out(res,400,{error:'Invalid property photo path.'});const {error}=await c.storage.from('property-images').remove([sp]);if(error)throw error;return out(res,200,{ok:true});
    }
    if(p==='/api/admin/properties'&&req.method==='GET'){
      await ownerAuth(req,c);const {data,error}=await c.from('properties').select('*').order('created_at',{ascending:false});if(error)throw error;const ids=(data||[]).map(x=>x.id);let priv=[];if(ids.length){const x=await c.from('property_private_details').select('*').in('property_id',ids);if(x.error)throw x.error;priv=x.data||[]}const map=Object.fromEntries(priv.map(x=>[x.property_id,x]));return out(res,200,{properties:(data||[]).map(x=>({...x,...(map[x.id]||{})}))});
    }
    if(p==='/api/admin/properties'&&req.method==='POST'){
      await ownerAuth(req,c);const b=await body(req),pub=cleanPublic(b),priv=cleanPrivate(b),problem=validateProperty(pub);if(problem)return out(res,400,{error:problem});const {data,error}=await c.from('properties').insert(pub).select('*').single();if(error)throw error;if(Object.keys(priv).length){const {error:pe}=await c.from('property_private_details').upsert({property_id:data.id,...priv});if(pe)throw pe}return out(res,201,{property:{...data,...priv}});
    }
    let pm=p.match(/^\/api\/admin\/properties\/([0-9a-f-]+)$/i);
    if(pm&&req.method==='PATCH'){
      await ownerAuth(req,c);const b=await body(req),pub=cleanPublic(b),priv=cleanPrivate(b);if(Object.keys(pub).length){const cur=await propertyById(c,pm[1],false),problem=validateProperty({...cur,...pub});if(problem)return out(res,400,{error:problem});const {error}=await c.from('properties').update(pub).eq('id',pm[1]);if(error)throw error}if(Object.keys(priv).length){const {error}=await c.from('property_private_details').upsert({property_id:pm[1],...priv});if(error)throw error}return out(res,200,{ok:true});
    }
    if(p==='/api/admin/blocked-dates'&&req.method==='GET'){await ownerAuth(req,c);const {data,error}=await c.from('blocked_dates').select('id,property_id,start_date,end_date,reason,properties(name)').order('start_date');if(error)throw error;return out(res,200,{blockedDates:data||[]})}
    if(p==='/api/admin/blocked-dates'&&req.method==='POST'){await ownerAuth(req,c);const b=await body(req);if(!dateOK(b.start_date)||!dateOK(b.end_date)||b.end_date<=b.start_date)return out(res,400,{error:'End date must be after start date.'});const {data,error}=await c.from('blocked_dates').insert({property_id:b.property_id,start_date:b.start_date,end_date:b.end_date,reason:txt(b.reason,200)}).select('*').single();if(error)throw error;return out(res,201,{blockedDate:data})}
    let bm=p.match(/^\/api\/admin\/blocked-dates\/([0-9a-f-]+)$/i);if(bm&&req.method==='DELETE'){await ownerAuth(req,c);const {error}=await c.from('blocked_dates').delete().eq('id',bm[1]);if(error)throw error;return out(res,200,{ok:true})}

    if(p==='/api/admin/booking-requests'&&req.method==='GET'){
      await ownerAuth(req,c);await expireStale(c);const {data,error}=await c.from('booking_requests').select('id,request_code,user_id,property_id,check_in,check_out,guests,message_to_host,total_amount,status,owner_decision_message,requested_at,approved_until,reservation_id,properties(name,general_area)').order('requested_at',{ascending:false});if(error)throw error;
      const ids=[...new Set((data||[]).map(x=>x.user_id))];let profiles=[];if(ids.length){const pr=await c.from('guest_profiles').select('user_id,legal_first_name,legal_last_name,preferred_name,phone,phone_verified,identity_status,identity_verified_at,created_at').in('user_id',ids);if(pr.error)throw pr.error;profiles=pr.data||[]}const pm0=Object.fromEntries(profiles.map(x=>[x.user_id,x]));
      const enriched=[];for(const r of data||[]){let email='';try{email=(await c.auth.admin.getUserById(r.user_id)).data?.user?.email||''}catch{}const pf=pm0[r.user_id]||{};const {count}=await c.from('reservations').select('id',{count:'exact',head:true}).eq('guest_user_id',r.user_id).in('status',['confirmed','paid']);enriched.push({...r,guest:{name:[pf.legal_first_name,pf.legal_last_name].filter(Boolean).join(' '),preferred_name:pf.preferred_name||null,identity_verified:pf.identity_status==='verified',phone_verified:!!pf.phone_verified,email_verified:true,email_masked:maskEmail(email),phone_masked:pf.phone_verified?maskPhone(pf.phone):'',account_created_at:pf.created_at,prior_stays:count||0}})}
      return out(res,200,{requests:enriched});
    }
    let br=p.match(/^\/api\/admin\/booking-requests\/([0-9a-f-]+)\/(approve|decline)$/i);
    if(br&&req.method==='POST'){
      await ownerAuth(req,c);const b=await body(req),id=br[1],action=br[2].toLowerCase(),message=txt(b.message,2000);
      if(action==='approve'){
        const {data,error}=await c.rpc('approve_booking_request',{p_request_id:id,p_payment_window_minutes:Number(b.paymentWindowMinutes||1440)});if(error){const m=String(error.message||'');if(/DATES_|PROPERTY_|REQUEST_/.test(m))return out(res,409,{error:'This request can no longer be approved because the dates or request status changed.'});throw error}
        if(message){await c.from('booking_requests').update({owner_decision_message:message}).eq('id',id);await c.from('booking_request_messages').insert({booking_request_id:id,sender:'owner',body:message,read_by_owner_at:new Date().toISOString()})}
        const {data:r}=await c.from('booking_requests').select('user_id,request_code,approved_until,properties(name)').eq('id',id).single();let em='';try{em=(await c.auth.admin.getUserById(r.user_id)).data?.user?.email||''}catch{}sendEmail(em,`Booking request approved — ${r.properties?.name||'All In Properties'}`,`<p>Your booking request <b>${r.request_code}</b> was approved.</p><p>Sign in to your Guest Portal and complete payment before ${r.approved_until} to confirm the reservation.</p>`);
        return out(res,200,{approved:true,result:data});
      }else{
        const {data:r,error}=await c.from('booking_requests').update({status:'declined',owner_decision_message:message||'The owner was unable to accept this booking request.',reviewed_at:new Date().toISOString()}).eq('id',id).eq('status','requested').select('user_id,request_code,properties(name)').maybeSingle();if(error)throw error;if(!r)return out(res,409,{error:'This request is no longer pending.'});await c.from('booking_request_messages').insert({booking_request_id:id,sender:'system',body:message||'The owner was unable to accept this booking request.',read_by_owner_at:new Date().toISOString()});let em='';try{em=(await c.auth.admin.getUserById(r.user_id)).data?.user?.email||''}catch{}sendEmail(em,`Booking request update — ${r.properties?.name||'All In Properties'}`,`<p>Your booking request <b>${r.request_code}</b> was not accepted.</p><p>${message||'Please return to the website to choose different dates or another stay.'}</p>`);return out(res,200,{declined:true});
      }
    }
    if(p==='/api/admin/request-messages'&&req.method==='GET'){await ownerAuth(req,c);const u=new URL(req.url,'http://x'),id=u.searchParams.get('requestId');return out(res,200,{messages:await requestThread(c,id,'owner')})}
    if(p==='/api/admin/request-messages'&&req.method==='POST'){await ownerAuth(req,c);const b=await body(req),id=String(b.requestId||''),message=txt(b.message,2000);if(!message)return out(res,400,{error:'Write a message first.'});const {data,error}=await c.from('booking_request_messages').insert({booking_request_id:id,sender:'owner',body:message,read_by_owner_at:new Date().toISOString()}).select('id,sender,body,created_at').single();if(error)throw error;return out(res,201,{message:data})}

    if(p==='/api/admin/reservations'&&req.method==='GET'){
      await ownerAuth(req,c);await expireStale(c);const {data,error}=await c.from('reservations').select('id,confirmation_code,property_id,guest_name,guest_email,guest_phone,check_in,check_out,guests,total_amount,status,hold_expires_at,created_at,stripe_payment_intent_id,owner_checkin_message,access_code,special_requests,properties(name)').order('created_at',{ascending:false});if(error)throw error;
      const ids=(data||[]).map(x=>x.id);let counts={};if(ids.length){const {data:m}=await c.from('reservation_messages').select('reservation_id').in('reservation_id',ids).eq('sender','guest').is('read_by_owner_at',null);for(const row of m||[])counts[row.reservation_id]=(counts[row.reservation_id]||0)+1}
      return out(res,200,{reservations:(data||[]).map(x=>({...x,unread_guest_messages:counts[x.id]||0}))});
    }
    let rd=p.match(/^\/api\/admin\/reservations\/([0-9a-f-]+)$/i);
    if(rd&&req.method==='GET'){await ownerAuth(req,c);return out(res,200,await adminReservationDetail(c,rd[1]))}
    if(rd&&req.method==='PATCH'){await ownerAuth(req,c);const b=await body(req),u={};if('owner_checkin_message'in b)u.owner_checkin_message=txt(b.owner_checkin_message,4000);if('access_code'in b)u.access_code=txt(b.access_code,200);if('internal_notes'in b)u.internal_notes=txt(b.internal_notes,4000);if(!Object.keys(u).length)return out(res,400,{error:'No reservation details to update.'});const {error}=await c.from('reservations').update(u).eq('id',rd[1]);if(error)throw error;return out(res,200,{ok:true})}
    if(p==='/api/admin/messages'&&req.method==='GET'){await ownerAuth(req,c);const u=new URL(req.url,'http://x'),rid=u.searchParams.get('reservationId');return out(res,200,{messages:await reservationThread(c,rid,'owner')})}
    if(p==='/api/admin/messages'&&req.method==='POST'){await ownerAuth(req,c);const b=await body(req),rid=String(b.reservationId||''),message=txt(b.message,2000);if(!message)return out(res,400,{error:'Write a message first.'});const {data,error}=await c.from('reservation_messages').insert({reservation_id:rid,sender:'owner',body:message,read_by_owner_at:new Date().toISOString()}).select('id,sender,body,created_at').single();if(error)throw error;return out(res,201,{message:data})}

    if(p==='/api/create-checkout'&&req.method==='POST')return out(res,410,{error:'Direct anonymous checkout is disabled. Guests must create an account, verify their email, phone, and identity, submit a booking request, and receive owner approval before payment.'});

    return out(res,404,{error:'Not found'});
  }catch(e){
    console.error(e);
    let msg=e.status?e.message:String(e.message||'Server error.');
    if(/permission denied for table/i.test(msg))msg='A database permission is not configured correctly.';
    if(/Bucket not found/i.test(msg))msg='Property photo storage is not configured.';
    return out(res,e.status||500,{error:msg});
  }
};
