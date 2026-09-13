const {createClient}=require('@supabase/supabase-js');
const Stripe=require('stripe');
const crypto=require('crypto');

const U=process.env.NEXT_PUBLIC_SUPABASE_URL||process.env.SUPABASE_URL;
const K=process.env.SUPABASE_SECRET_KEY;
const P=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY||process.env.SUPABASE_PUBLISHABLE_KEY;
const E=String(process.env.OWNER_ADMIN_EMAIL||'').toLowerCase().trim();
const LIVE_ENABLED=String(process.env.ENABLE_LIVE_CHECKOUT||'').toLowerCase()==='true';
const LIVE_KEY=process.env.STRIPE_SECRET_KEY||'';
const TEST_KEY=process.env.STRIPE_TEST_SECRET_KEY||'';

function activeStripeKey(){
  if(LIVE_ENABLED){
    if(LIVE_KEY.startsWith('sk_live_'))return LIVE_KEY;
    if(LIVE_KEY.startsWith('sk_test_'))return LIVE_KEY;
    return '';
  }
  if(TEST_KEY.startsWith('sk_test_'))return TEST_KEY;
  if(LIVE_KEY.startsWith('sk_test_'))return LIVE_KEY;
  return '';
}
function stripeMode(){
  const k=activeStripeKey();
  return k.startsWith('sk_live_')?'live':k.startsWith('sk_test_')?'test':'none';
}
function j(r,s,b){r.statusCode=s;r.setHeader('content-type','application/json; charset=utf-8');r.setHeader('cache-control','no-store');r.end(JSON.stringify(b))}
function path(req){try{return new URL(req.url,'http://x').pathname}catch{return req.url||'/'}}
async function body(req){if(req.body&&Buffer.isBuffer(req.body))return JSON.parse(req.body.toString('utf8')||'{}');if(req.body&&typeof req.body==='object')return req.body;if(typeof req.body==='string')return JSON.parse(req.body||'{}');let s='';for await(const c of req)s+=c;return JSON.parse(s||'{}')}
function requireEnv(){if(!U||!K){let e=Error('Supabase server configuration is missing.');e.status=503;throw e}}
const sb=()=>{requireEnv();return createClient(U,K,{auth:{persistSession:false,autoRefreshToken:false}})};
function base(req){return`${req.headers['x-forwarded-proto']||'https'}://${req.headers['x-forwarded-host']||req.headers.host}`}
function nights(a,b){const x=Date.parse(a+'T00:00:00Z'),y=Date.parse(b+'T00:00:00Z');return Number.isFinite(x)&&Number.isFinite(y)?Math.round((y-x)/86400000):NaN}
function isDate(s){return/^\d{4}-\d{2}-\d{2}$/.test(String(s||''))&&!Number.isNaN(Date.parse(s+'T00:00:00Z'))}
function todayUTC(){return new Date().toISOString().slice(0,10)}
function confirmationCode(){return'AIP-'+crypto.randomBytes(3).toString('hex').toUpperCase()+'-'+Date.now().toString().slice(-6)}
function text(v,max=4000){v=String(v??'').trim();return v?v.slice(0,max):null}
function clean(b){
  const x={};
  for(const k of['name','location','description','house_rules','check_in_time','check_out_time'])if(k in b)x[k]=text(b[k],k==='description'?4000:500);
  for(const k of['nightly_rate','cleaning_fee','tax_rate','max_guests','bedrooms','bathrooms','minimum_nights'])if(k in b)x[k]=b[k]===null?null:Number(b[k]);
  if('active'in b)x.active=!!b.active;if('featured'in b)x.featured=!!b.featured;
  if('image_urls'in b)x.image_urls=Array.isArray(b.image_urls)?b.image_urls.filter(v=>typeof v==='string'&&/^https:\/\//i.test(v)).slice(0,12):[];
  if('amenities'in b)x.amenities=Array.isArray(b.amenities)?[...new Set(b.amenities.map(v=>String(v).trim()).filter(Boolean))].slice(0,40):[];
  return x;
}
function validateProperty(x){
  if(!x.name)return'Property name is required.';
  if(!Number.isFinite(x.nightly_rate)||x.nightly_rate<0)return'Enter a valid nightly rate.';
  if(x.cleaning_fee!=null&&(!Number.isFinite(x.cleaning_fee)||x.cleaning_fee<0))return'Enter a valid cleaning fee.';
  if(x.tax_rate!=null&&(!Number.isFinite(x.tax_rate)||x.tax_rate<0||x.tax_rate>1))return'Tax rate must be between 0% and 100%.';
  if(!Number.isInteger(x.max_guests)||x.max_guests<1)return'Maximum guests must be at least 1.';
  if(x.minimum_nights!=null&&(!Number.isInteger(x.minimum_nights)||x.minimum_nights<1))return'Minimum nights must be at least 1.';
  return null;
}
async function admin(req,c){
  if(!E){let e=Error('OWNER_ADMIN_EMAIL is not configured.');e.status=503;throw e}
  const h=req.headers.authorization||'',t=h.startsWith('Bearer ')?h.slice(7):'';
  const {data,error}=await c.auth.getUser(t),email=String(data?.user?.email||'').toLowerCase().trim();
  if(error||!data?.user){let e=Error('Please sign in again.');e.status=401;throw e}
  if(email!==E){let e=Error('This account is not authorized.');e.status=403;throw e}
  return data.user;
}
async function getProperty(c,id,activeOnly=true){
  if(!/^[0-9a-f-]{36}$/i.test(String(id||'')))return null;
  let q=c.from('properties').select('*').eq('id',id);if(activeOnly)q=q.eq('active',true);
  const {data,error}=await q.maybeSingle();if(error)throw error;return data||null;
}
async function availability(c,id,ci,co,g){
  if(!isDate(ci)||!isDate(co))return{available:false,error:'Choose valid check-in and check-out dates.'};
  if(ci<todayUTC())return{available:false,error:'Check-in cannot be in the past.'};
  const n=nights(ci,co);if(!Number.isInteger(n)||n<1||n>60)return{available:false,error:'Stay length must be between 1 and 60 nights.'};
  const p=await getProperty(c,id,true);if(!p)return{available:false,error:'Property not found or not published.'};
  if(n<Number(p.minimum_nights||1))return{available:false,error:`This property requires at least ${p.minimum_nights||1} night${Number(p.minimum_nights||1)===1?'':'s'}.`};
  if(!Number.isInteger(Number(g))||Number(g)<1)return{available:false,error:'Guest count must be at least 1.'};
  if(Number(g)>Number(p.max_guests||1))return{available:false,error:`This property allows up to ${p.max_guests} guests.`};
  const {data:bl,error:be}=await c.from('blocked_dates').select('id').eq('property_id',id).lt('start_date',co).gt('end_date',ci).limit(1);if(be)throw be;if(bl?.length)return{available:false,error:'Those dates are blocked.'};
  const cutoff=new Date(Date.now()-30*60*1000).toISOString();
  const {data:rs,error:re}=await c.from('reservations').select('id,status,created_at').eq('property_id',id).lt('check_in',co).gt('check_out',ci).in('status',['confirmed','paid','pending']);if(re)throw re;
  if((rs||[]).some(r=>r.status!=='pending'||String(r.created_at)>=cutoff))return{available:false,error:'Those dates are already reserved.'};
  return{available:true,property:p,nights:n};
}
function quoteFrom(av){
  const p=av.property,n=av.nights,nightlyRate=Number(p.nightly_rate||0),nightlySubtotal=nightlyRate*n,cleaningFee=Number(p.cleaning_fee||0),taxRate=Number(p.tax_rate||0),taxes=Math.round((nightlySubtotal+cleaningFee)*taxRate*100)/100,total=Math.round((nightlySubtotal+cleaningFee+taxes)*100)/100;
  return{nights:n,nightlyRate,nightlySubtotal,cleaningFee,taxRate,taxes,total};
}
async function confirmSession(c,session){
  if(!session||session.payment_status!=='paid')return{confirmed:false};
  const rid=session.metadata?.reservation_id,code=session.metadata?.confirmation_code;if(!rid)return{confirmed:false};
  const pi=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id;
  const {error}=await c.from('reservations').update({status:'confirmed',stripe_payment_intent_id:pi||null}).eq('id',rid);if(error)throw error;
  if(pi){
    const {error:pe}=await c.from('payments').upsert({reservation_id:rid,stripe_payment_intent_id:pi,amount:Number(session.amount_total||0)/100,currency:session.currency||'usd',status:'paid'},{onConflict:'stripe_payment_intent_id'});if(pe)throw pe;
  }
  return{confirmed:true,confirmationCode:code||null};
}
module.exports=async(req,res)=>{
  let c;
  try{
    const p=path(req);c=sb();
    if(p==='/api/health'&&req.method==='GET')return j(res,200,{ok:true});
    if(p==='/api/config'&&req.method==='GET')return j(res,200,{supabaseUrl:U,supabasePublishableKey:P});

    if(p==='/api/properties'&&req.method==='GET'){
      const {data,error}=await c.from('properties').select('*').eq('active',true).order('featured',{ascending:false}).order('created_at',{ascending:true});if(error)throw error;return j(res,200,{properties:data||[]});
    }
    if(p==='/api/availability'&&req.method==='GET'){
      const u=new URL(req.url,'http://x'),r=await availability(c,u.searchParams.get('propertyId'),u.searchParams.get('checkIn'),u.searchParams.get('checkOut'),Number(u.searchParams.get('guests')||1));return j(res,200,r);
    }
    if(p==='/api/quote'&&req.method==='GET'){
      const u=new URL(req.url,'http://x'),a=await availability(c,u.searchParams.get('propertyId'),u.searchParams.get('checkIn'),u.searchParams.get('checkOut'),Number(u.searchParams.get('guests')||1));if(!a.available)return j(res,409,{error:a.error});return j(res,200,quoteFrom(a));
    }

    if(p==='/api/admin/me'&&req.method==='GET'){const u=await admin(req,c);return j(res,200,{email:u.email})}
    if(p==='/api/admin/health'&&req.method==='GET'){
      await admin(req,c);let database=false,storage=false;try{let r=await c.from('properties').select('id').limit(1);database=!r.error}catch{}
      try{let r=await c.storage.getBucket('property-images');storage=!r.error}catch{}
      return j(res,200,{database,storage,stripeMode:stripeMode(),liveCheckoutEnabled:LIVE_ENABLED&&stripeMode()==='live',webhookConfigured:!!(process.env.STRIPE_WEBHOOK_SECRET||process.env.STRIPE_TEST_WEBHOOK_SECRET)});
    }
    if(p==='/api/admin/photo-upload-url'&&req.method==='POST'){
      await admin(req,c);const b=await body(req),mime=String(b.contentType||'image/jpeg').toLowerCase();if(!mime.startsWith('image/'))return j(res,400,{error:'Please choose an image file.'});
      let ext=(String(b.filename||'photo.jpg').split('.').pop()||'jpg').toLowerCase().replace(/[^a-z0-9]/g,'');if(!['jpg','jpeg','png','webp','heic','heif'].includes(ext))ext='jpg';
      const storagePath=`properties/${Date.now()}-${crypto.randomUUID()}.${ext}`,{data,error}=await c.storage.from('property-images').createSignedUploadUrl(storagePath,{upsert:false});if(error)throw error;const {data:pub}=c.storage.from('property-images').getPublicUrl(storagePath);return j(res,200,{path:data.path||storagePath,token:data.token,publicUrl:pub.publicUrl});
    }
    if(p==='/api/admin/photo-delete'&&req.method==='POST'){
      await admin(req,c);const b=await body(req),url=String(b.url||''),marker='/storage/v1/object/public/property-images/';let i=url.indexOf(marker);if(i<0)return j(res,400,{error:'Invalid property photo URL.'});let storagePath=decodeURIComponent(url.slice(i+marker.length).split('?')[0]);if(!storagePath.startsWith('properties/'))return j(res,400,{error:'Invalid property photo path.'});const {error}=await c.storage.from('property-images').remove([storagePath]);if(error)throw error;return j(res,200,{ok:true});
    }
    if(p==='/api/admin/properties'&&req.method==='GET'){
      await admin(req,c);const {data,error}=await c.from('properties').select('*').order('created_at',{ascending:false});if(error)throw error;return j(res,200,{properties:data||[]});
    }
    if(p==='/api/admin/properties'&&req.method==='POST'){
      await admin(req,c);const x=clean(await body(req)),problem=validateProperty(x);if(problem)return j(res,400,{error:problem});const {data,error}=await c.from('properties').insert(x).select('*').single();if(error)throw error;return j(res,201,{property:data});
    }
    let pm=p.match(/^\/api\/admin\/properties\/([0-9a-f-]+)$/i);
    if(pm&&req.method==='PATCH'){
      await admin(req,c);const x=clean(await body(req));if('name'in x||'nightly_rate'in x||'max_guests'in x){const merged={...(await getProperty(c,pm[1],false)),...x},problem=validateProperty(merged);if(problem)return j(res,400,{error:problem})}const {data,error}=await c.from('properties').update(x).eq('id',pm[1]).select('*').single();if(error)throw error;return j(res,200,{property:data});
    }

    if(p==='/api/admin/blocked-dates'&&req.method==='GET'){await admin(req,c);const {data,error}=await c.from('blocked_dates').select('id,property_id,start_date,end_date,reason,properties(name)').order('start_date');if(error)throw error;return j(res,200,{blockedDates:data||[]})}
    if(p==='/api/admin/blocked-dates'&&req.method==='POST'){await admin(req,c);const b=await body(req);if(!isDate(b.start_date)||!isDate(b.end_date)||b.end_date<=b.start_date)return j(res,400,{error:'End date must be after start date.'});const {data,error}=await c.from('blocked_dates').insert({property_id:b.property_id,start_date:b.start_date,end_date:b.end_date,reason:text(b.reason,200)}).select('*').single();if(error)throw error;return j(res,201,{blockedDate:data})}
    let bm=p.match(/^\/api\/admin\/blocked-dates\/([0-9a-f-]+)$/i);if(bm&&req.method==='DELETE'){await admin(req,c);const {error}=await c.from('blocked_dates').delete().eq('id',bm[1]);if(error)throw error;return j(res,200,{ok:true})}

    if(p==='/api/admin/reservations'&&req.method==='GET'){await admin(req,c);const {data,error}=await c.from('reservations').select('id,confirmation_code,guest_name,guest_email,guest_phone,check_in,check_out,guests,total_amount,status,created_at,stripe_payment_intent_id,properties(name)').order('created_at',{ascending:false});if(error)throw error;return j(res,200,{reservations:data||[]})}

    if(p==='/api/create-checkout'&&req.method==='POST'){
      const key=activeStripeKey();if(!key)return j(res,503,{error:LIVE_ENABLED?'Stripe live checkout is not configured correctly.':'Checkout is in safe mode. Add a Stripe test key for testing, or enable live checkout only after final launch checks.'});
      const b=await body(req),name=text(b.guestName,150),email=String(b.guestEmail||'').trim().toLowerCase(),phone=text(b.guestPhone,50);if(!name||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return j(res,400,{error:'A valid guest name and email are required.'});
      const a=await availability(c,b.propertyId,b.checkIn,b.checkOut,Number(b.guests||1));if(!a.available)return j(res,409,{error:a.error});const q=quoteFrom(a),pr=a.property,conf=confirmationCode();
      const {data:h,error:he}=await c.rpc('create_reservation_hold',{p_confirmation_code:conf,p_property_id:pr.id,p_guest_name:name,p_guest_email:email,p_guest_phone:phone,p_check_in:b.checkIn,p_check_out:b.checkOut,p_guests:Number(b.guests||1),p_nightly_subtotal:q.nightlySubtotal,p_cleaning_fee:q.cleaningFee,p_taxes:q.taxes,p_total_amount:q.total});
      if(he){const m=String(he.message||'');if(m.includes('DATES_UNAVAILABLE')||m.includes('BLOCKED_DATES'))return j(res,409,{error:'Those dates were just taken. Please choose different dates.'});throw he}
      const rid=Array.isArray(h)?h[0]?.reservation_id:(h?.reservation_id||h),st=new Stripe(key),session=await st.checkout.sessions.create({mode:'payment',customer_email:email,expires_at:Math.floor(Date.now()/1000)+1800,line_items:[{quantity:1,price_data:{currency:'usd',unit_amount:Math.round(q.total*100),product_data:{name:`${pr.name} — ${q.nights} night${q.nights===1?'':'s'}`,description:`${b.checkIn} to ${b.checkOut} · includes cleaning fee and taxes`}}}],metadata:{reservation_id:String(rid),confirmation_code:conf,property_id:pr.id},success_url:`${base(req)}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,cancel_url:`${base(req)}/?checkout=cancelled`},{idempotencyKey:`checkout-${rid}`});
      const {error:ue}=await c.from('reservations').update({stripe_checkout_session_id:session.id}).eq('id',rid);if(ue)throw ue;return j(res,200,{url:session.url});
    }

    if(p==='/api/finalize'&&req.method==='GET'){
      const key=activeStripeKey();if(!key)return j(res,503,{error:'Stripe is not configured.'});const u=new URL(req.url,'http://x'),sid=u.searchParams.get('session_id');if(!sid)return j(res,400,{error:'Missing session.'});const st=new Stripe(key),session=await st.checkout.sessions.retrieve(sid),out=await confirmSession(c,session);return j(res,200,out);
    }

    return j(res,404,{error:'Not found'});
  }catch(e){
    console.error(e);let msg=e.status?e.message:String(e.message||'Server error.');
    if(/permission denied for table/i.test(msg))msg='Database permission error. Please contact the site owner.';
    if(/Bucket not found/i.test(msg))msg='Property photo storage is not configured.';
    return j(res,e.status||500,{error:msg});
  }
};
module.exports.confirmSession=confirmSession;
module.exports.activeStripeKey=activeStripeKey;
module.exports.stripeMode=stripeMode;