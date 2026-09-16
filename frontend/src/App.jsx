import { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { BrowserRouter } from 'react-router-dom';
import AppRoutes from './app/routes.jsx';
import { restoreSession } from './features/auth/authSlice.js';

export default function App() {
  const dispatch = useDispatch();

  // The access token lives in memory only, so a reload starts with no token.
  // The HttpOnly refresh cookie is what decides whether a session survives.
  useEffect(() => {
    dispatch(restoreSession());
  }, [dispatch]);

  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
