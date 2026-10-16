/* Exercise the token checker against stubbed Graph API responses. */
import { checkToken } from './token-check.mjs';

let pass=0, fail=0;
const ok=(n,c,d='')=>{ if(c){pass++;console.log(`PASS  ${n}`);} else {fail++;console.log(`FAIL  ${n}${d?'  ['+d+']':''}`);} };

const realFetch = globalThis.fetch;
const stub = (handler) => { globalThis.fetch = async (url) => handler(String(url)); };
const json = (obj, status=200) => ({ ok: status<400, status, text: async()=>JSON.stringify(obj) });

const days = n => Math.floor((Date.now() + n*86400000)/1000);

// healthy, 45 days left
stub(u => u.includes('debug_token') ? json({data:{is_valid:true, expires_at:days(45)}}) : json({},404));
let r = await checkToken('tok');
ok('healthy token reports ok', r.state==='ok' && r.days===44||r.days===45, `${r.state} ${r.days}`);

// expiring in 10 days
stub(u => u.includes('debug_token') ? json({data:{is_valid:true, expires_at:days(10)}}) : json({},404));
r = await checkToken('tok');
ok('a token expiring in 10 days warns', r.state==='expiring', `${r.state} ${r.days}`);

// right on the warn boundary
stub(u => u.includes('debug_token') ? json({data:{is_valid:true, expires_at:days(30)}}) : json({},404));
r = await checkToken('tok', {warnDays:21});
ok('30 days out does not warn yet', r.state==='ok', r.state);

// never expires (page token)
stub(u => u.includes('debug_token') ? json({data:{is_valid:true, expires_at:0}}) : json({},404));
r = await checkToken('tok');
ok('a non-expiring token is ok', r.state==='ok' && r.neverExpires===true, r.state);

// already expired
stub(u => u.includes('debug_token') ? json({data:{is_valid:true, expires_at:days(-2)}}) : json({},404));
r = await checkToken('tok');
ok('an expired token reports invalid', r.state==='invalid', `${r.state} ${r.days}`);

// revoked
stub(u => u.includes('debug_token') ? json({data:{is_valid:false, error:{message:'Session revoked'}}}) : json({},404));
r = await checkToken('tok');
ok('a revoked token reports invalid', r.state==='invalid' && /revoked/i.test(r.detail), r.detail);

// debug_token refused, but the token still works
stub(u => u.includes('debug_token') ? json({error:{message:'no'}},403) : json({id:'123'}));
r = await checkToken('tok');
ok('falls back to a validity probe', r.state==='unknown' && /works/.test(r.detail), r.detail);

// debug_token refused and the token is rejected
stub(u => u.includes('debug_token') ? json({error:{message:'no'}},403)
                                    : json({error:{message:'Invalid OAuth access token'}},400));
r = await checkToken('tok');
ok('a rejected token reports invalid', r.state==='invalid', `${r.state} ${r.detail}`);

// the network is down — must NOT claim the token is bad
stub(() => { throw new Error('getaddrinfo ENOTFOUND graph.facebook.com'); });
try { r = await checkToken('tok'); ok('network failure is not reported as a bad token', false, 'did not throw to caller'); }
catch (e) { ok('network failure surfaces to the caller, which maps it to unknown', true); }

// server error — unknown, not invalid
stub(u => json({error:{message:'try later'}}, 500));
r = await checkToken('tok');
ok('a 500 is unknown, not invalid', r.state==='unknown', r.state);

// the token must never be echoed back
stub(u => u.includes('debug_token') ? json({data:{is_valid:false, error:{message:'bad token SECRETTOKEN123'}}})
                                    : json({},404));
r = await checkToken('SECRETTOKEN123');
ok('a bare token quoted in an API error is redacted', !/SECRETTOKEN123/.test(JSON.stringify(r)), JSON.stringify(r));

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
