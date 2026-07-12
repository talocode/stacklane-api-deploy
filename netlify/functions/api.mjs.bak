import { randomUUID } from 'node:crypto'

export const config = { path: '/*', preferStatic: true }

function makeRequestId() { return `sl_req_${randomUUID().replace(/-/g, '').slice(0, 16)}` }
function extractApiKey(headers) {
  const a = headers['authorization'] || headers['Authorization'] || '';
  if (a.startsWith('Bearer ')) return a.slice(7).trim();
  return headers['x-api-key'] || headers['X-Api-Key'] || null
}

async function handler(event) {
  const method = event.httpMethod || 'GET', path = event.path || '/', headers = event.headers || {}
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body,'base64').toString('utf-8') : event.body) : null
  const rid = makeRequestId()

  if ((method==='GET'||method==='HEAD') && (path==='/'||path==='/health'||path==='/api/v1/health')) {
    return { statusCode:200, headers:{'Content-Type':'application/json'}, body:JSON.stringify({status:'ok',service:'stacklane-api',version:'0.1.0',requestId:rid,timestamp:new Date().toISOString()}) }
  }

  if (path==='/api/v1/cloud/pricing') {
    return { statusCode:200, headers:{'Content-Type':'application/json'}, body:JSON.stringify({pricing:{tera_api:{'chat.completions':3,'writing.rewrite':5,'writing.draft':10,'coding.explain':10,'coding.review':20,'coding.write':20}},requestId:rid}) }
  }

  if (path==='/api/v1/cloud/usage/charge' && method==='POST') {
    const apiKey = extractApiKey(headers)
    if (!apiKey) return { statusCode:401, headers:{'Content-Type':'application/json'}, body:JSON.stringify({error:{code:'missing_api_key',message:'API key required',requestId:rid}}) }
    let payload
    try { payload = typeof body === 'string' ? JSON.parse(body) : body } catch { return { statusCode:400, headers:{'Content-Type':'application/json'}, body:JSON.stringify({error:{code:'invalid_request',message:'Invalid JSON',requestId:rid}}) } }
    if (!payload.action || !payload.credits) return { statusCode:400, headers:{'Content-Type':'application/json'}, body:JSON.stringify({error:{code:'invalid_request',message:'action and credits required',requestId:rid}}) }

    try {
      const su = process.env.SUPABASE_URL, sk = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!su||!sk) return { statusCode:200, headers:{'Content-Type':'application/json'}, body:JSON.stringify({data:{ok:true,event:{credits:payload.credits,status:'charged',product:payload.product,action:payload.action,requestId:rid}},meta:{requestId:rid}}) }
      const u = await (await fetch(`${su}/rest/v1/api_keys?select=user_id&api_key=eq.${encodeURIComponent(apiKey)}`,{headers:{apikey:sk,Authorization:`Bearer ${sk}`}})).json()
      if (!u||!u.length) return { statusCode:401, headers:{'Content-Type':'application/json'}, body:JSON.stringify({error:{code:'invalid_api_key',message:'API key not found',requestId:rid}}) }
      const uid = u[0].user_id
      const p = await (await fetch(`${su}/rest/v1/profiles?select=purchased_credits_balance&id=eq.${uid}`,{headers:{apikey:sk,Authorization:`Bearer ${sk}`}})).json()
      if (!p||!p.length) return { statusCode:402, headers:{'Content-Type':'application/json'}, body:JSON.stringify({error:{code:'insufficient_credits',message:'No credits found',requestId:rid}}) }
      const bal = p[0].purchased_credits_balance||0
      if (bal < payload.credits) return { statusCode:402, headers:{'Content-Type':'application/json'}, body:JSON.stringify({error:{code:'insufficient_credits',message:`Need ${payload.credits}, have ${bal}`,requestId:rid}}) }
      await fetch(`${su}/rest/v1/profiles?id=eq.${uid}`,{method:'PATCH',headers:{apikey:sk,Authorization:`Bearer ${sk}`,'Content-Type':'application/json',Prefer:'return=minimal'},body:JSON.stringify({purchased_credits_balance:bal-payload.credits})})
      await fetch(`${su}/rest/v1/usage_events`,{method:'POST',headers:{apikey:sk,Authorization:`Bearer ${sk}`,'Content-Type':'application/json'},body:JSON.stringify({user_id:uid,product:payload.product||'tera_api',action:payload.action,credits:payload.credits,metadata:payload.metadata||{}})}).catch(()=>{})
      return { statusCode:200, headers:{'Content-Type':'application/json'}, body:JSON.stringify({data:{ok:true,event:{credits:payload.credits,status:'charged',product:payload.product,action:payload.action,requestId:rid}},meta:{requestId:rid}}) }
    } catch(err) {
      return { statusCode:503, headers:{'Content-Type':'application/json'}, body:JSON.stringify({error:{code:'billing_unavailable',message:err.message,requestId:rid}}) }
    }
  }
  return { statusCode:404, headers:{'Content-Type':'application/json'}, body:JSON.stringify({error:{code:'not_found',message:`Unknown: ${path}`,requestId:rid}}) }
}
export { handler }
