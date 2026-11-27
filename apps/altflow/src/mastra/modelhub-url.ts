export function modelHubBaseURL(baseURL = 'https://modelhub.altflow.cn/v1') {
  const url = new URL(baseURL);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
  ) {
    throw new Error('ModelHub requires HTTPS or an explicit loopback test server');
  }
  return url.href.replace(/\/$/, '');
}
