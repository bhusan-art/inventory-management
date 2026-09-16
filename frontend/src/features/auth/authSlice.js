import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api, { setAccessToken, refreshSession, toMessage } from '../../lib/apiClient.js';

/**
 * Session state.
 *
 * `permissions` comes from GET /auth/me, never from decoding the JWT on the
 * client. The client has no business parsing tokens, and one authoritative
 * shape means the UI guards and the server agree by construction.
 */
export const login = createAsyncThunk('auth/login', async (credentials, { rejectWithValue }) => {
  try {
    const res = await api.post('/auth/login', credentials);
    setAccessToken(res.data.data.accessToken);
    return res.data.data.session;
  } catch (error) {
    return rejectWithValue(toMessage(error, 'Unable to sign in'));
  }
});

/** Runs once at boot: the refresh cookie decides whether a session exists. */
export const restoreSession = createAsyncThunk('auth/restore', async (_, { rejectWithValue }) => {
  try {
    await refreshSession();
    const res = await api.get('/auth/me');
    return res.data.data;
  } catch {
    return rejectWithValue(null);
  }
});

export const logout = createAsyncThunk('auth/logout', async () => {
  try {
    await api.post('/auth/logout');
  } finally {
    setAccessToken(null);
  }
});

export const changePassword = createAsyncThunk(
  'auth/changePassword',
  async (payload, { rejectWithValue }) => {
    try {
      await api.post('/auth/change-password', payload);
      setAccessToken(null);
      return true;
    } catch (error) {
      return rejectWithValue(toMessage(error, 'Unable to change password'));
    }
  },
);

const initialState = {
  session: null,
  permissions: [],
  status: 'idle', // idle | restoring | authenticated | anonymous
  error: null,
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    sessionLost(state) {
      state.session = null;
      state.permissions = [];
      state.status = 'anonymous';
      setAccessToken(null);
    },
    clearError(state) {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(restoreSession.pending, (state) => {
        state.status = 'restoring';
      })
      .addCase(restoreSession.fulfilled, (state, action) => {
        state.session = action.payload;
        state.permissions = action.payload.permissions ?? [];
        state.status = 'authenticated';
      })
      .addCase(restoreSession.rejected, (state) => {
        state.status = 'anonymous';
      })
      .addCase(login.pending, (state) => {
        state.error = null;
      })
      .addCase(login.fulfilled, (state, action) => {
        state.session = action.payload;
        state.permissions = action.payload.permissions ?? [];
        state.status = 'authenticated';
        state.error = null;
      })
      .addCase(login.rejected, (state, action) => {
        state.error = action.payload;
        state.status = 'anonymous';
      })
      .addCase(logout.fulfilled, (state) => {
        state.session = null;
        state.permissions = [];
        state.status = 'anonymous';
      })
      .addCase(changePassword.fulfilled, (state) => {
        // Changing a password revokes every session, including this one.
        state.session = null;
        state.permissions = [];
        state.status = 'anonymous';
      })
      .addCase(changePassword.rejected, (state, action) => {
        state.error = action.payload;
      });
  },
});

export const { sessionLost, clearError } = authSlice.actions;
export default authSlice.reducer;
