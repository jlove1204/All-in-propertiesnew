const {createClient}=require('@supabase/supabase-js');
const Stripe=require('stripe');
const getRawBody=require('raw-body');

const U=process.env.NEXT_PUBLIC_SUPABASE_URL||process.env.SUPABASE_URL;
const K=process.env.SUPABASE_SECRET_KEY;
const LIVE_ENABLED=String(process.env.ENABLE_LIVE_CHECKOUT||'').toLowerCase()==='true';
const LIVE_KEY=process.env.STRIPE_SECRET_KEY||'';
const TEST_KEY=process.env.STRIPE_TEST_SECRET_KEY||'';
const WEBHOOK_SECRET=LIVE_ENABLED?(process.env.STRIPE_WEBHOOK_SECRET||''):(process.env.STRIPE_TEST_WEBHOOK_SECRET||process.env.STRIPE_WEBHOOK_SECRET||'');
const RESEND_KEY=process.env.RESEND_API_KEY||'';
const FROM_EMAIL=process.env.FROM_EMAIL||'';

function key(){
  if(LIVE_ENABLED)return LIVE_KEY.startsWith('sk_')?LIVE_KEY:'';
  if(TEST_KEY.startsWith('sk_test_'))return TEST_KEY;
  if(LIVE_KEY.startsWith('sk_test_'))return LIVE_KEY;
  return'';
}
function json(res,status,data){res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(data))}
async function sendEmail(to,subject,html){
  if(!RESEND_KEY||!FROM_EMAIL||!to)return;
  try{await fetch('https://api.resend.com/emails',{method:'POST',headers:{authorization:`Bearer ${RESEND_KEY}`,'content-type':'application/json'},body:JSON.stringify({from:FROM_EMAIL,to:[to],subject,html})})}catch{}
}
async function confirm(c,session){
  const rid=session.metadata?.reservation_id,requestId=session.metadata?.booking_request_id;if(!rid)return;
  const pi=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id;
  const {data:r,error}=await c.from('reservations').update({status:'confirmed',stripe_payment_intent_id:pi||null,hold_expires_at:null}).eq('id',rid).select('guest_email,confirmation_code,property_id,properties(name)').single();if(error)throw error;
  if(requestId)await c.from('booking_requests').update({status:'paid'}).eq('id',requestId);
  if(pi){const {error:pe}=await c.from('payments').upsert({reservation_id:rid,stripe_payment_intent_id:pi,amount:Number(session.amount_total||0)/100,currency:session.currency||'usd',status:'paid'},{onConflict:'stripe_payment_intent_id'});if(pe)throw pe}
  await sendEmail(r.guest_email,`Reservation confirmed — ${r.properties?.name||'All In Properties'}`,`<p>Your payment was received and your reservation is confirmed.</p><p>Confirmation: <b>${r.confirmation_code}</b></p><p>Sign in to your Guest Portal for the exact address, check-in information, and messages.</p>`);
}
async function expire(c,session){
  const rid=session.metadata?.reservation_id,requestId=session.metadata?.booking_request_id;
  if(rid)await c.from('reservations').update({status:'cancelled',cancelled_at:new Date().toISOString(),cancellation_reason:'Checkout expired or payment failed'}).eq('id',rid).eq('status','pending');
  if(requestId)await c.from('booking_requests').update({status:'expired'}).eq('id',requestId).eq('status','approved');
}
async function identity(c,obj,eventType){
  const userId=obj.metadata?.user_id||obj.client_reference_id;if(!userId)return;
  let status='pending',err=null,verifiedAt=null;
  if(eventType==='identity.verification_session.verified'){status='verified';verifiedAt=new Date().toISOString()}
  else if(eventType==='identity.verification_session.requires_input'){status='requires_input';err=obj.last_error?.reason||obj.last_error?.code||'Verification requires more information.'}
  else if(eventType==='identity.verification_session.canceled')status='failed';
  else if(eventType==='identity.verification_session.redacted')status='redacted';
  await c.from('guest_profiles').upsert({user_id:userId,stripe_identity_session_id:obj.id,identity_status:status,identity_verified_at:verifiedAt,identity_last_error:err});
}
async function handler(req,res){
  if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  if(!U||!K||!key()||!WEBHOOK_SECRET)return json(res,503,{error:'Webhook not configured'});
  try{
    const raw=await getRawBody(req),sig=req.headers['stripe-signature'];if(!sig)return json(res,400,{error:'Missing Stripe signature'});
    const st=new Stripe(key()),event=st.webhooks.constructEvent(raw,sig,WEBHOOK_SECRET),c=createClient(U,K,{auth:{persistSession:false,autoRefreshToken:false}});
    if(event.type==='checkout.session.completed'||event.type==='checkout.session.async_payment_succeeded'){if(event.data.object.payment_status==='paid')await confirm(c,event.data.object)}
    if(event.type==='checkout.session.expired'||event.type==='checkout.session.async_payment_failed')await expire(c,event.data.object);
    if(event.type.startsWith('identity.verification_session.'))await identity(c,event.data.object,event.type);
    return json(res,200,{received:true});
  }catch(e){console.error(e);return json(res,400,{error:'Webhook verification or processing failed'})}
}
module.exports=handler;
module.exports.config={api:{bodyParser:false}};
