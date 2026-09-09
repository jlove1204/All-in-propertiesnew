const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const STRIPE_KEY = process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET_KEY;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
function pathOf(req) {
  try { return new URL(req.url, 'http://localhost').pathname; } catch { return req.url || '/'; }
}
function nightsBetween(a,b){
  const x = new Date(`${a}T00:00:00Z`), y = new Date(`${b}T00:00:00Z`);
  return Math.round((y-x)/86400000);
}
function cents(n){ return Math.round(Number(n) * 100); }
function confirmationCode(){
  return 'AIP-' + Math.random().toString(36).slice(2,8).toUpperCase() + '-' + Date.now().toString().slice(-6);
}
async function readJson(req){
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  let raw=''; for await (const c of req) raw += c;
  return JSON.parse(raw || '{}');
}
function getClients(){
  if(!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('Supabase server environment variables are missing.');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {auth:{persistSession:false,autoRefreshToken:false}});
  const stripe = STRIPE_KEY ? new Stripe(STRIPE_KEY) : null;
  return {supabase,stripe};
}

module.exports = async (req,res) => {
  const route = pathOf(req);
  try {
    const {supabase, stripe} = getClients();

    if (route === '/api/properties' && req.method === 'GET') {
      const {data,error} = await supabase.from('properties').select('id,name,description,location,nightly_rate,cleaning_fee,tax_rate,max_guests,bedrooms,bathrooms').eq('active',true).order('created_at',{ascending:true});
      if(error) throw error;
      return json(res,200,{properties:data||[]});
    }

    if (route === '/api/create-checkout' && req.method === 'POST') {
      if(!stripe) return json(res,503,{error:'Stripe is not configured on the server yet.'});

      // Safety lock: never use a live Stripe key until the owner explicitly enables it.
      const usingLiveKey = String(STRIPE_KEY||'').startsWith('sk_live_');
      if (usingLiveKey && process.env.ENABLE_LIVE_CHECKOUT !== 'true') {
        return json(res,503,{error:'Live charging is intentionally locked. Add a Stripe test secret key for testing, or enable live checkout only after final safeguards are complete.'});
      }

      const body = await readJson(req);
      const {propertyId,checkIn,checkOut,guestName,guestEmail,guestPhone} = body;
      const guests = Number(body.guests||1);
      if(!propertyId||!checkIn||!checkOut||!guestName||!guestEmail) return json(res,400,{error:'Please complete the required booking fields.'});
      const nights = nightsBetween(checkIn,checkOut);
      if(!Number.isInteger(nights)||nights<1||nights>60) return json(res,400,{error:'Choose a valid stay between 1 and 60 nights.'});

      const {data:property,error:pErr}=await supabase.from('properties').select('*').eq('id',propertyId).eq('active',true).single();
      if(pErr||!property) return json(res,404,{error:'Property not found.'});
      if(guests<1||guests>Number(property.max_guests)) return json(res,400,{error:`This property allows up to ${property.max_guests} guests.`});

      const subtotal = Number(property.nightly_rate) * nights;
      const cleaning = Number(property.cleaning_fee||0);
      const taxes = (subtotal + cleaning) * Number(property.tax_rate||0);
      const total = subtotal + cleaning + taxes;
      const code = confirmationCode();

      // Atomic reservation hold RPC. Run supabase-booking-safety.sql before testing.
      const {data:hold,error:hErr}=await supabase.rpc('create_reservation_hold',{
        p_confirmation_code:code,
        p_property_id:propertyId,
        p_guest_name:String(guestName).trim(),
        p_guest_email:String(guestEmail).trim().toLowerCase(),
        p_guest_phone:guestPhone ? String(guestPhone).trim() : null,
        p_check_in:checkIn,
        p_check_out:checkOut,
        p_guests:guests,
        p_nightly_subtotal:subtotal,
        p_cleaning_fee:cleaning,
        p_taxes:taxes,
        p_total_amount:total
      });
      if(hErr){
        const msg = String(hErr.message||'');
        if(msg.includes('DATES_UNAVAILABLE')) return json(res,409,{error:'Those dates are no longer available. Please choose different dates.'});
        if(msg.includes('BLOCKED_DATES')) return json(res,409,{error:'Those dates are blocked for this property.'});
        throw hErr;
      }
      const reservationId = Array.isArray(hold) ? hold[0]?.reservation_id : hold?.reservation_id || hold;
      if(!reservationId) throw new Error('Reservation hold could not be created.');

      const session = await stripe.checkout.sessions.create({
        mode:'payment',
        customer_email:String(guestEmail).trim().toLowerCase(),
        expires_at:Math.floor(Date.now()/1000)+30*60,
        line_items:[{
          quantity:1,
          price_data:{
            currency:'usd',
            unit_amount:cents(total),
            product_data:{name:`${property.name} — ${nights} night${nights===1?'':'s'}`,description:`${checkIn} to ${checkOut}`}
          }
        }],
        metadata:{reservation_id:String(reservationId),confirmation_code:code,property_id:String(propertyId)},
        success_url:`${baseUrl(req)}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:`${baseUrl(req)}/?checkout=cancelled`
      });

      await supabase.from('reservations').update({stripe_checkout_session_id:session.id}).eq('id',reservationId);
      return json(res,200,{url:session.url});
    }

    if (route === '/api/finalize' && req.method === 'POST') {
      if(!stripe) return json(res,503,{error:'Stripe is not configured.'});
      const body = await readJson(req);
      const sessionId = body.sessionId;
      if(!sessionId) return json(res,400,{error:'Missing checkout session.'});
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if(session.payment_status !== 'paid') return json(res,402,{error:'Payment has not been confirmed by Stripe.'});
      const reservationId = session.metadata?.reservation_id;
      if(!reservationId) return json(res,400,{error:'Reservation metadata is missing.'});
      const {data:r,error:rErr}=await supabase.from('reservations').update({
        status:'confirmed',
        stripe_payment_intent_id:typeof session.payment_intent==='string'?session.payment_intent:null
      }).eq('id',reservationId).select('confirmation_code,total_amount,check_in,check_out').single();
      if(rErr) throw rErr;
      if(session.payment_intent){
        await supabase.from('payments').upsert({
          reservation_id:reservationId,
          stripe_payment_intent_id:String(session.payment_intent),
          amount:Number(session.amount_total||0)/100,
          currency:String(session.currency||'usd'),
          status:'paid'
        },{onConflict:'stripe_payment_intent_id'});
      }
      return json(res,200,{reservation:r});
    }

    if (route === '/api/health' && req.method === 'GET') {
      return json(res,200,{ok:true,supabase:!!SUPABASE_URL,stripe:!!STRIPE_KEY,liveLocked:String(STRIPE_KEY||'').startsWith('sk_live_')&&process.env.ENABLE_LIVE_CHECKOUT!=='true'});
    }

    return json(res,404,{error:'Not found'});
  } catch (err) {
    console.error(err);
    return json(res,500,{error:'Server error. Please try again.',detail:process.env.NODE_ENV==='development'?String(err.message||err):undefined});
  }
};
