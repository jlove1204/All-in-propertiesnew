const {createClient}=require('@supabase/supabase-js');
const Stripe=require('stripe');
const getRawBody=require('raw-body');

const U=process.env.NEXT_PUBLIC_SUPABASE_URL||process.env.SUPABASE_URL;
const K=process.env.SUPABASE_SECRET_KEY;
const LIVE_ENABLED=String(process.env.ENABLE_LIVE_CHECKOUT||'').toLowerCase()==='true';
const LIVE_KEY=process.env.STRIPE_SECRET_KEY||'';
const TEST_KEY=process.env.STRIPE_TEST_SECRET_KEY||'';
const WEBHOOK_SECRET=LIVE_ENABLED?(process.env.STRIPE_WEBHOOK_SECRET||''):(process.env.STRIPE_TEST_WEBHOOK_SECRET||process.env.STRIPE_WEBHOOK_SECRET||'');

function key(){
  if(LIVE_ENABLED)return LIVE_KEY.startsWith('sk_')?LIVE_KEY:'';
  if(TEST_KEY.startsWith('sk_test_'))return TEST_KEY;
  if(LIVE_KEY.startsWith('sk_test_'))return LIVE_KEY;
  return'';
}
function json(res,status,data){res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(data))}
async function confirm(c,session){
  const rid=session.metadata?.reservation_id;if(!rid)return;
  const pi=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id;
  const {error}=await c.from('reservations').update({status:'confirmed',stripe_payment_intent_id:pi||null}).eq('id',rid);if(error)throw error;
  if(pi){const {error:pe}=await c.from('payments').upsert({reservation_id:rid,stripe_payment_intent_id:pi,amount:Number(session.amount_total||0)/100,currency:session.currency||'usd',status:'paid'},{onConflict:'stripe_payment_intent_id'});if(pe)throw pe}
}
async function cancel(c,session){
  const rid=session.metadata?.reservation_id;if(!rid)return;
  const {error}=await c.from('reservations').update({status:'cancelled'}).eq('id',rid).eq('status','pending');if(error)throw error;
}
async function handler(req,res){
  if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  if(!U||!K||!key()||!WEBHOOK_SECRET)return json(res,503,{error:'Webhook not configured'});
  try{
    const raw=await getRawBody(req),sig=req.headers['stripe-signature'];if(!sig)return json(res,400,{error:'Missing Stripe signature'});
    const st=new Stripe(key()),event=st.webhooks.constructEvent(raw,sig,WEBHOOK_SECRET),c=createClient(U,K,{auth:{persistSession:false,autoRefreshToken:false}});
    if(event.type==='checkout.session.completed'||event.type==='checkout.session.async_payment_succeeded'){if(event.data.object.payment_status==='paid')await confirm(c,event.data.object)}
    if(event.type==='checkout.session.expired'||event.type==='checkout.session.async_payment_failed')await cancel(c,event.data.object);
    return json(res,200,{received:true});
  }catch(e){console.error(e);return json(res,400,{error:'Webhook verification or processing failed'})}
}
module.exports=handler;
module.exports.config={api:{bodyParser:false}};