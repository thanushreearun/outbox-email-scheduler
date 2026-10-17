import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useMe } from '../../hooks/queries';
import { FullPageError, FullPageSpinner } from '../../components/ui/States';

/** Gate for authenticated routes. The server remains the real authority (401s). */
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <FullPageSpinner />;
  if (me.isError)
    return <FullPageError message="Could not reach the server." onRetry={() => void me.refetch()} />;
  if (!me.data) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}
