export const AUTHORIZATION_MS=72*60*60*1000;
export function authorizedControl(control,now=Date.now()){
  return !!control&&Number.isSafeInteger(control.authorizationExpiresAt)&&control.authorizationExpiresAt>now&&!!(control.enabled===true||control.resumeAfterKeyId);
}
export function executionEnabled(control,keyId,now=Date.now()){
  return authorizedControl(control,now)&&(control.enabled===true||control.resumeAfterKeyId===keyId);
}
