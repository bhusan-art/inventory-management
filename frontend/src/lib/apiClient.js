import axios from 'axios';

/**
 * API client.
 *
 * The access token is held in a module variable, not localStorage. It does not
 * survive a page reload — and it does not need to, because the HttpOnly refresh
 * cookie silently re-issues one on boot. Anything written to localStorage is
 * readable by any script on the page and persists indefinitely; a variable is
 * neither.
 */
let accessToken = null;
let onSessionLost = () => {};

export function setAccessToken(token) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

export function onSessionExpired(handler) {
  onSessionLost = handler;
}

export const api = axios.create({
  baseURL: '/api/v1',
  withCredentials: true, // refresh cookie
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});

/**
 * Single-flight refresh.
 *
 * Without the shared promise, five components rendering at once each hit a 401
 * and each fire a refresh. Four of those present a token the first has already
 * rotated, which the backend correctly reads as token theft and responds to by
 * killing the entire session. The queue is not an optimization — it is what
 * stops the client tripping its own reuse detection.
 */
let refreshPromise = null;

function refreshSession() {
  refreshPromise ??= api
    .post('/auth/refresh')
    .then((res) => {
      setAccessToken(res.data.data.accessToken);
      return res.data.data;
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    const status = error.response?.status;
    const code = error.response?.data?.errors?.[0]?.code;

    const isAuthEndpoint = original?.url?.includes('/auth/refresh') || original?.url?.includes('/auth/login');

    if (status === 401 && !original?._retried && !isAuthEndpoint) {
      original._retried = true;
      try {
        await refreshSession();
        return api(original);
      } catch {
        onSessionLost(code);
        return Promise.reject(error);
      }
    }

    if (status === 401 && isAuthEndpoint && original?.url?.includes('/auth/refresh')) {
      onSessionLost(code);
    }

    return Promise.reject(error);
  },
);

/** Normalizes the API's error envelope into something components can render. */
export function toMessage(error, fallback = 'Something went wrong') {
  return error?.response?.data?.message ?? error?.message ?? fallback;
}

export function fieldErrors(error) {
  const errors = error?.response?.data?.errors ?? [];
  return errors.reduce((acc, e) => {
    if (e.field) acc[e.field.replace(/^body\./, '')] = e.message ?? e.code;
    return acc;
  }, {});
}

export { refreshSession };
export default api;
