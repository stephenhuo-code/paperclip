/** Sends the browser to the identity provider's sign-in page. */
export function redirectToSso(url: string) {
  window.location.assign(url);
}
