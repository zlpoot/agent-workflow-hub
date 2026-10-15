/** Shared V1/V2 transport. All execution and authority remain in the existing server. */
export async function localFastRequest(action:string,data:Record<string,unknown>,signal:AbortSignal) {
  const response=await fetch('/dashboard/local-fast/v1/'+action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal});
  if(response.status===404)throw new Error('local_fast_unavailable');
  const value=await response.json();
  if(!response.ok||value.authority_verified!==false||!value.item)throw new Error(value.error?.code??'unavailable');
  return value.item;
}
