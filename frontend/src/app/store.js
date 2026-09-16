import { configureStore } from '@reduxjs/toolkit';
import authReducer, { sessionLost } from '../features/auth/authSlice.js';
import { onSessionExpired } from '../lib/apiClient.js';

export const store = configureStore({
  reducer: { auth: authReducer },
});

// When the refresh cookie is gone or the backend invalidated the session, the
// interceptor tells the store rather than redirecting imperatively — routing
// stays a function of state.
onSessionExpired(() => store.dispatch(sessionLost()));

export default store;
