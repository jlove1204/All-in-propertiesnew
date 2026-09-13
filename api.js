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
const TERMS_VERSION='2026-09-v1';

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

function key(){
  if(LIVE_ENABLED){
    if(LIVE_KEY.startsWith('sk_live_'))return LIVE_KEY;
    if(LIVE_KEY.startsWith('sk_test_'))return LIVE_KEY;
    return '';
  }
  if(TEST_KEY.startsWith('sk_test_'))return TEST_KEY;
  if(LIVE_KEY.startsWith('sk_test_'))return LIVE_KEY;
  return '';
}
function stripeMode(){const k=key();return k.startsWith('sk_live_')?'live':k.startsWith('sk_test_')?'test':'none'}
function json(res,status,data){res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store, max-age=0');res.end(JSON.stringify(data))}
function pathname(req){try{return new URL(req.url,'http://x').pathname}catch{return req.url||'/'}}
async function readBody(req){
  if(req.body&&Buffer.isBuffer(req.body))return JSON.parse(req.body.toString('utf8')||'{}');
  if(req.body&&typeof req.body==='object')return req.body;
  if(typeof req.body==='string')return JSON.parse(req.body||'{}');
  let s='';for await(const c of req)s+=c;if(s.length>1000000){let e=Error('Request too large.');e.status=413;throw e}
  return JSON.parse(s||'{}');
}
function client(){if(!U||!K){let e=Error('Supabase server configuration is missing.');e.status=503;throw e}return createClient(U,K,{auth:{persistSession:false,autoRefreshToken:false}})}
function base(req){return`${req.headers['x-forwarded-proto']||'https'}://${req.headers['x-forwarded-host']||req.headers.host}`}
function txt(v,max=4000){v=String(v??'').trim();return v?v.slice(0,max):null}
function bool(v){return v===true||v==='true'||v===1||v==='1'}
function dateOK(v){return/^\d{4}-\d{2}-\d{2}$/.test(String(v||''))&&!Number.isNaN(Date.parse(v+'T00:00:00Z'))}
function today(){return new Date().toISOString().slice(0,10)}
function nights(a,b){const x=Date.parse(a+'T00:00:00Z'),y=Date.parse(b+'T00:00:00Z');return Number.isFinite(x)&&Number.isFinite(y)?Math.round((y-x)/86400000):NaN}
function code(){return'AIP-'+crypto.randomBytes(3).toString('hex').toUpperCase()+'-'+Date.now().toString().slice(-6)}
function token(){return crypto.randomBytes(32).toString('hex')}
function hashToken(t){return crypto.createHash('sha256').update(String(t||'')).digest('hex')}
function emailOK(v){return/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v||'').trim())}
function safeStatus(s){return['pending','confirmed','paid','cancelled'].includes(s)?s:'pending'}

function cleanPublic(b){
  const x={};
  for(const k of ['name','location','general_area','general_area_description','description','house_rules','check_in_time','check_out_time','cancellation_policy']){
    if(k in b)x[k]=txt(b[k],k==='description'||k==='general_area_description'||k==='cancellation_policy'?4000:500);
  }
  for(const k of ['nightly_rate','cleaning_fee','tax_rate','max_guests','bedrooms','bathrooms','minimum_nights']){
    if(k in b)x[k]=b[k]===null||b[k]===''?null:Number(b[k]);
  }
  for(const k of ['active','featured','pets_allowed','smoking_allowed','parties_allowed'])if(k in b)x[k]=bool(b[k]);
  if('image_urls'in b)x.image_urls=Array.isArray(b.image_urls)?b.image_urls.filter(v=>typeof v==='string'&&/^https:\/\//i.test(v)).slice(0,12):[];
  if('amenities'in b)x.amenities=Array.isArray(b.amenities)?[...new Set(b.amenities.map(v=>String(v).trim()).filter(Boolean))].slice(0,50):[];
  return x;
}
function cleanPrivate(b){
  const x={};
  for(const k of PRIVATE_FIELDS)if(k in b)x[k]=txt(b[k],4000);
  return x;
}
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
async function guestAuth(req,c){
  const h=req.headers.authorization||'',t=h.startsWith('Bearer ')?h.slice(7):'';
  if(!/^[a-f0-9]{64}$/i.test(t)){let e=Error('Guest portal session is missing or expired.');e.status=401;throw e}
  const {data,error}=await c.from('reservations').select('*').eq('guest_portal_token_hash',hashToken(t)).maybeSingle();
  if(error)throw error;if(!data){let e=Error('Guest portal session is invalid.');e.status=401;throw e}
  c.from('reservations').update({guest_portal_last_accessed_at:new Date().toISOString()}).eq('id',data.id).then(()=>{}).catch(()=>{});
  return data;
}
async function issueGuestToken(c,reservationId){
  const t=token(),h=hashToken(t),now=new Date().toISOString();
  const {error}=await c.from('reservations').update({guest_portal_token_hash:h,guest_portal_token_created_at:now,guest_portal_last_accessed_at:now}).eq('id',reservationId);
  if(error)throw error;return t;
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
async function availability(c,id,ci,co,g){
  if(!dateOK(ci)||!dateOK(co))return{available:false,error:'Choose valid check-in and check-out dates.'};
  if(ci<today())return{available:false,error:'Check-in cannot be in the past.'};
  const n=nights(ci,co);if(!Number.isInteger(n)||n<1||n>60)return{available:false,error:'Stay length must be between 1 and 60 nights.'};
  const p=await propertyById(c,id,true);if(!p)return{available:false,error:'Property not found or not published.'};
  if(n<Number(p.minimum_nights||1))return{available:false,error:`This property requires at least ${p.minimum_nights||1} night${Number(p.minimum_nights||1)===1?'':'s'}.`};
  g=Number(g);if(!Number.isInteger(g)||g<1)return{available:false,error:'Guest count must be at least 1.'};
  if(g>Number(p.max_guests||1))return{available:false,error:`This property allows up to ${p.max_guests} guests.`};
  const {data:bl,error:be}=await c.from('blocked_dates').select('id').eq('property_id',id).lt('start_date',co).gt('end_date',ci).limit(1);if(be)throw be;if(bl?.length)return{available:false,error:'Those dates are blocked.'};
  const cutoff=new Date(Date.now()-30*60*1000).toISOString();
  const {data:rs,error:re}=await c.from('reservations').select('id,status,created_at').eq('property_id',id).lt('check_in',co).gt('check_out',ci).in('status',['confirmed','paid','pending']);if(re)throw re;
  if((rs||[]).some(r=>r.status!=='pending'||String(r.created_at)>=cutoff))return{available:false,error:'Those dates are already reserved.'};
  return{available:true,property:p,nights:n};
}
function quoteFrom(a){
  const p=a.property,n=a.nights,nightlyRate=Number(p.nightly_rate||0),nightlySubtotal=Math.round(nightlyRate*n*100)/100,cleaningFee=Number(p.cleaning_fee||0),taxRate=Number(p.tax_rate||0),taxes=Math.round((nightlySubtotal+cleaningFee)*taxRate*100)/100,total=Math.round((nightlySubtotal+cleaningFee+taxes)*100)/100;
  return{nights:n,nightlyRate,nightlySubtotal,cleaningFee,taxRate,taxes,total};
}
async function confirmSession(c,session){
  if(!session||session.payment_status!=='paid')return{confirmed:false};
  const rid=session.metadata?.reservation_id,confirmation=session.metadata?.confirmation_code;if(!rid)return{confirmed:false};
  const pi=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id;
  const {error}=await c.from('reservations').update({status:'confirmed',stripe_payment_intent_id:pi||null}).eq('id',rid);if(error)throw error;
  if(pi){
    const {error:pe}=await c.from('payments').upsert({reservation_id:rid,stripe_payment_intent_id:pi,amount:Number(session.amount_total||0)/100,currency:session.currency||'usd',status:'paid'},{onConflict:'stripe_payment_intent_id'});if(pe)throw pe;
  }
  return{confirmed:true,reservationId:rid,confirmationCode:confirmation||null};
}
function exactAddress(priv){
  return [priv.address_line1,priv.address_line2,priv.city,priv.state_region,priv.postal_code].filter(Boolean).join(', ');
}
async function guestReservationPayload(c,r){
  const p=await propertyById(c,r.property_id,false);if(!p)throw Error('Property not found.');
  const allowed=['confirmed','paid'].includes(r.status);
  const priv=allowed?await privateFor(c,r.property_id):{};
  return{
    reservation:{id:r.id,confirmation_code:r.confirmation_code,guest_name:r.guest_name,guest_email:r.guest_email,guest_phone:r.guest_phone,check_in:r.check_in,check_out:r.check_out,guests:r.guests,total_amount:r.total_amount,status:r.status,created_at:r.created_at,owner_checkin_message:allowed?r.owner_checkin_message:null,access_code:allowed?r.access_code:null,special_requests:r.special_requests},
    property:p,
    private:allowed?{...priv,exact_address:exactAddress(priv)}:{},
    exactDetailsAvailable:allowed
  };
}
async function messageRateLimit(c,reservationId,sender){
  const since=new Date(Date.now()-10*60*1000).toISOString();
  const {count,error}=await c.from('reservation_messages').select('id',{count:'exact',head:true}).eq('reservation_id',reservationId).eq('sender',sender).gte('created_at',since);
  if(error)throw error;if(Number(count||0)>=20){let e=Error('Too many messages sent. Please wait a few minutes.');e.status=429;throw e}
}
async function getMessages(c,reservationId,reader){
  if(reader==='owner')await c.from('reservation_messages').update({read_by_owner_at:new Date().toISOString()}).eq('reservation_id',reservationId).eq('sender','guest').is('read_by_owner_at',null);
  if(reader==='guest')await c.from('reservation_messages').update({read_by_guest_at:new Date().toISOString()}).eq('reservation_id',reservationId).eq('sender','owner').is('read_by_guest_at',null);
  const {data,error}=await c.from('reservation_messages').select('id,sender,body,created_at,read_by_owner_at,read_by_guest_at').eq('reservation_id',reservationId).order('created_at',{ascending:true}).limit(500);
  if(error)throw error;return data||[];
}
async function adminReservationDetail(c,id){
  const {data:r,error}=await c.from('reservations').select('*').eq('id',id).maybeSingle();if(error)throw error;if(!r){let e=Error('Reservation not found.');e.status=404;throw e}
  const p=await propertyById(c,r.property_id,false),priv=await privateFor(c,r.property_id);
  return{reservation:r,property:p,private:{...priv,exact_address:exactAddress(priv)}};
}

module.exports=async(req,res)=>{
  let c;
  try{
    const p=pathname(req);c=client();

    if(p==='/api/health'&&req.method==='GET')return json(res,200,{ok:true});
    if(p==='/api/config'&&req.method==='GET')return json(res,200,{supabaseUrl:U,supabasePublishableKey:P});

    if(p==='/api/properties'&&req.method==='GET'){
      const {data,error}=await c.from('properties').select(PUBLIC_PROPERTY_FIELDS).eq('active',true).order('featured',{ascending:false}).order('created_at',{ascending:true});
      if(error)throw error;return json(res,200,{properties:data||[]});
    }
    if(p==='/api/availability'&&req.method==='GET'){
      const u=new URL(req.url,'http://x'),a=await availability(c,u.searchParams.get('propertyId'),u.searchParams.get('checkIn'),u.searchParams.get('checkOut'),Number(u.searchParams.get('guests')||1));return json(res,200,a);
    }
    if(p==='/api/quote'&&req.method==='GET'){
      const u=new URL(req.url,'http://x'),a=await availability(c,u.searchParams.get('propertyId'),u.searchParams.get('checkIn'),u.searchParams.get('checkOut'),Number(u.searchParams.get('guests')||1));if(!a.available)return json(res,409,{error:a.error});return json(res,200,quoteFrom(a));
    }

    if(p==='/api/admin/me'&&req.method==='GET'){const u=await ownerAuth(req,c);return json(res,200,{email:u.email})}
    if(p==='/api/admin/health'&&req.method==='GET'){
      await ownerAuth(req,c);let database=false,storage=false,messaging=false;
      try{let r=await c.from('properties').select('id').limit(1);database=!r.error}catch{}
      try{let r=await c.storage.getBucket('property-images');storage=!r.error}catch{}
      try{let r=await c.from('reservation_messages').select('id').limit(1);messaging=!r.error}catch{}
      return json(res,200,{database,storage,messaging,stripeMode:stripeMode(),liveCheckoutEnabled:LIVE_ENABLED&&stripeMode()==='live',webhookConfigured:!!(process.env.STRIPE_WEBHOOK_SECRET||process.env.STRIPE_TEST_WEBHOOK_SECRET)});
    }
    if(p==='/api/admin/photo-upload-url'&&req.method==='POST'){
      await ownerAuth(req,c);const b=await readBody(req),mime=String(b.contentType||'image/jpeg').toLowerCase();if(!mime.startsWith('image/'))return json(res,400,{error:'Please choose an image file.'});
      let ext=(String(b.filename||'photo.jpg').split('.').pop()||'jpg').toLowerCase().replace(/[^a-z0-9]/g,'');if(!['jpg','jpeg','png','webp','heic','heif'].includes(ext))ext='jpg';
      const storagePath=`properties/${Date.now()}-${crypto.randomUUID()}.${ext}`,{data,error}=await c.storage.from('property-images').createSignedUploadUrl(storagePath,{upsert:false});if(error)throw error;
      const {data:pub}=c.storage.from('property-images').getPublicUrl(storagePath);return json(res,200,{path:data.path||storagePath,token:data.token,publicUrl:pub.publicUrl});
    }
    if(p==='/api/admin/photo-delete'&&req.method==='POST'){
      await ownerAuth(req,c);const b=await readBody(req),url=String(b.url||''),marker='/storage/v1/object/public/property-images/';let i=url.indexOf(marker);if(i<0)return json(res,400,{error:'Invalid property photo URL.'});
      const storagePath=decodeURIComponent(url.slice(i+marker.length).split('?')[0]);if(!storagePath.startsWith('properties/'))return json(res,400,{error:'Invalid property photo path.'});
      const {error}=await c.storage.from('property-images').remove([storagePath]);if(error)throw error;return json(res,200,{ok:true});
    }
    if(p==='/api/admin/properties'&&req.method==='GET'){
      await ownerAuth(req,c);const {data,error}=await c.from('properties').select('*').order('created_at',{ascending:false});if(error)throw error;
      const {data:priv,error:pe}=await c.from('property_private_details').select('*');if(pe)throw pe;
      const map=new Map((priv||[]).map(x=>[x.property_id,x]));return json(res,200,{properties:(data||[]).map(x=>({...x,...(map.get(x.id)||{})}))});
    }
    if(p==='/api/admin/properties'&&req.method==='POST'){
      await ownerAuth(req,c);const b=await readBody(req),pub=cleanPublic(b),priv=cleanPrivate(b),problem=validateProperty(pub);if(problem)return json(res,400,{error:problem});
      const {data,error}=await c.from('properties').insert(pub).select('*').single();if(error)throw error;
      if(Object.keys(priv).length){const {error:pe}=await c.from('property_private_details').upsert({property_id:data.id,...priv,updated_at:new Date().toISOString()});if(pe)throw pe}
      return json(res,201,{property:{...data,...priv}});
    }
    let pm=p.match(/^\/api\/admin\/properties\/([0-9a-f-]+)$/i);
    if(pm&&req.method==='PATCH'){
      await ownerAuth(req,c);const b=await readBody(req),pub=cleanPublic(b),priv=cleanPrivate(b);
      if(Object.keys(pub).length){
        const current=await propertyById(c,pm[1],false),merged={...current,...pub},problem=validateProperty(merged);if(problem)return json(res,400,{error:problem});
        const {error}=await c.from('properties').update(pub).eq('id',pm[1]);if(error)throw error;
      }
      if(Object.keys(priv).length){const {error:pe}=await c.from('property_private_details').upsert({property_id:pm[1],...priv,updated_at:new Date().toISOString()});if(pe)throw pe}
      const current=await propertyById(c,pm[1],false),pv=await privateFor(c,pm[1]);return json(res,200,{property:{...current,...pv}});
    }

    if(p==='/api/admin/blocked-dates'&&req.method==='GET'){
      await ownerAuth(req,c);const {data,error}=await c.from('blocked_dates').select('id,property_id,start_date,end_date,reason,properties(name)').order('start_date');if(error)throw error;return json(res,200,{blockedDates:data||[]});
    }
    if(p==='/api/admin/blocked-dates'&&req.method==='POST'){
      await ownerAuth(req,c);const b=await readBody(req);if(!dateOK(b.start_date)||!dateOK(b.end_date)||b.end_date<=b.start_date)return json(res,400,{error:'End date must be after start date.'});
      const {data,error}=await c.from('blocked_dates').insert({property_id:b.property_id,start_date:b.start_date,end_date:b.end_date,reason:txt(b.reason,200)}).select('*').single();if(error)throw error;return json(res,201,{blockedDate:data});
    }
    let bm=p.match(/^\/api\/admin\/blocked-dates\/([0-9a-f-]+)$/i);
    if(bm&&req.method==='DELETE'){await ownerAuth(req,c);const {error}=await c.from('blocked_dates').delete().eq('id',bm[1]);if(error)throw error;return json(res,200,{ok:true})}

    if(p==='/api/admin/reservations'&&req.method==='GET'){
      await ownerAuth(req,c);const {data,error}=await c.from('reservations').select('id,confirmation_code,property_id,guest_name,guest_email,guest_phone,check_in,check_out,guests,total_amount,status,created_at,stripe_payment_intent_id,owner_checkin_message,access_code,special_requests,properties(name)').order('created_at',{ascending:false});if(error)throw error;
      const ids=(data||[]).map(x=>x.id);let counts={};if(ids.length){const {data:m,error:me}=await c.from('reservation_messages').select('reservation_id').in('reservation_id',ids).eq('sender','guest').is('read_by_owner_at',null);if(me)throw me;for(const row of m||[])counts[row.reservation_id]=(counts[row.reservation_id]||0)+1}
      return json(res,200,{reservations:(data||[]).map(x=>({...x,unread_guest_messages:counts[x.id]||0}))});
    }
    let rd=p.match(/^\/api\/admin\/reservations\/([0-9a-f-]+)$/i);
    if(rd&&req.method==='GET'){await ownerAuth(req,c);return json(res,200,await adminReservationDetail(c,rd[1]))}
    if(rd&&req.method==='PATCH'){
      await ownerAuth(req,c);const b=await readBody(req),update={};
      if('owner_checkin_message'in b)update.owner_checkin_message=txt(b.owner_checkin_message,4000);
      if('access_code'in b)update.access_code=txt(b.access_code,200);
      if('internal_notes'in b)update.internal_notes=txt(b.internal_notes,4000);
      if(!Object.keys(update).length)return json(res,400,{error:'No reservation details to update.'});
      const {error}=await c.from('reservations').update(update).eq('id',rd[1]);if(error)throw error;return json(res,200,{ok:true});
    }

    if(p==='/api/admin/messages'&&req.method==='GET'){
      await ownerAuth(req,c);const u=new URL(req.url,'http://x'),rid=u.searchParams.get('reservationId');if(!/^[0-9a-f-]{36}$/i.test(String(rid||'')))return json(res,400,{error:'Invalid reservation.'});
      return json(res,200,{messages:await getMessages(c,rid,'owner')});
    }
    if(p==='/api/admin/messages'&&req.method==='POST'){
      await ownerAuth(req,c);const b=await readBody(req),rid=String(b.reservationId||''),message=txt(b.message,2000);if(!/^[0-9a-f-]{36}$/i.test(rid)||!message)return json(res,400,{error:'Reservation and message are required.'});
      await messageRateLimit(c,rid,'owner');const {data,error}=await c.from('reservation_messages').insert({reservation_id:rid,sender:'owner',body:message,read_by_owner_at:new Date().toISOString()}).select('id,sender,body,created_at').single();if(error)throw error;
      return json(res,201,{message:data});
    }

    if(p==='/api/guest/login'&&req.method==='POST'){
      const b=await readBody(req),confirmation=String(b.confirmationCode||'').trim().toUpperCase(),email=String(b.email||'').trim().toLowerCase();
      if(!confirmation||!emailOK(email))return json(res,400,{error:'Enter your confirmation code and booking email.'});
      const {data,error}=await c.from('reservations').select('*').eq('confirmation_code',confirmation).ilike('guest_email',email).maybeSingle();if(error)throw error;
      if(!data)return json(res,404,{error:'We could not match that confirmation code and email.'});
      if(!['confirmed','paid'].includes(data.status))return json(res,403,{error:'Guest portal access becomes available after the booking is confirmed.'});
      const t=await issueGuestToken(c,data.id);return json(res,200,{token:t,confirmationCode:data.confirmation_code});
    }
    if(p==='/api/guest/reservation'&&req.method==='GET'){
      const r=await guestAuth(req,c);return json(res,200,await guestReservationPayload(c,r));
    }
    if(p==='/api/guest/messages'&&req.method==='GET'){
      const r=await guestAuth(req,c);return json(res,200,{messages:await getMessages(c,r.id,'guest')});
    }
    if(p==='/api/guest/messages'&&req.method==='POST'){
      const r=await guestAuth(req,c),b=await readBody(req),message=txt(b.message,2000);if(!message)return json(res,400,{error:'Write a message first.'});
      await messageRateLimit(c,r.id,'guest');const {data,error}=await c.from('reservation_messages').insert({reservation_id:r.id,sender:'guest',body:message,read_by_guest_at:new Date().toISOString()}).select('id,sender,body,created_at').single();if(error)throw error;
      return json(res,201,{message:data});
    }

    if(p==='/api/create-checkout'&&req.method==='POST'){
      const sk=key();if(!sk)return json(res,503,{error:LIVE_ENABLED?'Stripe live checkout is not configured correctly.':'Checkout is in safe mode while payment setup is being completed.'});
      const b=await readBody(req),name=txt(b.guestName,150),email=String(b.guestEmail||'').trim().toLowerCase(),phone=txt(b.guestPhone,50),special=txt(b.specialRequests,2000);
      if(!name||!emailOK(email))return json(res,400,{error:'A valid guest name and email are required.'});
      if(!bool(b.termsAccepted))return json(res,400,{error:'Please agree to the booking policies before checkout.'});
      const a=await availability(c,b.propertyId,b.checkIn,b.checkOut,Number(b.guests||1));if(!a.available)return json(res,409,{error:a.error});
      const q=quoteFrom(a),pr=a.property,confirmation=code(),acceptedAt=new Date().toISOString();
      const {data:h,error:he}=await c.rpc('create_reservation_hold',{p_confirmation_code:confirmation,p_property_id:pr.id,p_guest_name:name,p_guest_email:email,p_guest_phone:phone,p_check_in:b.checkIn,p_check_out:b.checkOut,p_guests:Number(b.guests||1),p_nightly_subtotal:q.nightlySubtotal,p_cleaning_fee:q.cleaningFee,p_taxes:q.taxes,p_total_amount:q.total});
      if(he){const m=String(he.message||'');if(m.includes('DATES_UNAVAILABLE')||m.includes('BLOCKED_DATES'))return json(res,409,{error:'Those dates were just taken. Please choose different dates.'});throw he}
      const rid=Array.isArray(h)?h[0]?.reservation_id:(h?.reservation_id||h);
      const {error:ue0}=await c.from('reservations').update({terms_accepted_at:acceptedAt,terms_version:TERMS_VERSION,special_requests:special}).eq('id',rid);if(ue0)throw ue0;
      const st=new Stripe(sk),session=await st.checkout.sessions.create({
        mode:'payment',customer_email:email,expires_at:Math.floor(Date.now()/1000)+1800,
        line_items:[{quantity:1,price_data:{currency:'usd',unit_amount:Math.round(q.total*100),product_data:{name:`${pr.name} — ${q.nights} night${q.nights===1?'':'s'}`,description:`${b.checkIn} to ${b.checkOut} · cleaning fee and taxes included`}}}],
        metadata:{reservation_id:String(rid),confirmation_code:confirmation,property_id:pr.id},
        success_url:`${base(req)}/guest?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:`${base(req)}/?checkout=cancelled`
      },{idempotencyKey:`checkout-${rid}`});
      const {error:ue}=await c.from('reservations').update({stripe_checkout_session_id:session.id}).eq('id',rid);if(ue)throw ue;return json(res,200,{url:session.url});
    }

    if(p==='/api/finalize'&&req.method==='GET'){
      const sk=key();if(!sk)return json(res,503,{error:'Stripe is not configured.'});const u=new URL(req.url,'http://x'),sid=u.searchParams.get('session_id');if(!sid)return json(res,400,{error:'Missing checkout session.'});
      const st=new Stripe(sk),session=await st.checkout.sessions.retrieve(sid),out=await confirmSession(c,session);
      if(!out.confirmed)return json(res,200,{confirmed:false});
      const t=await issueGuestToken(c,out.reservationId);return json(res,200,{confirmed:true,confirmationCode:out.confirmationCode,guestToken:t});
    }

    return json(res,404,{error:'Not found'});
  }catch(e){
    console.error(e);
    let msg=e.status?e.message:String(e.message||'Server error.');
    if(/permission denied for table/i.test(msg))msg='A database permission is not configured correctly.';
    if(/Bucket not found/i.test(msg))msg='Property photo storage is not configured.';
    return json(res,e.status||500,{error:msg});
  }
};