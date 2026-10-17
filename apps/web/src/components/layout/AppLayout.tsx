import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, Clock, LayoutDashboard, LogOut, Menu, Send, Settings, X } from 'lucide-react';
import { toast } from 'sonner';
import { useCounts, useLogout, useMe } from '../../hooks/queries';
import { cn } from '../../lib/cn';
import { Avatar } from '../ui/Avatar';
import { Logo } from '../ui/Logo';

function ProfileMenu() {
  const me = useMe().data!;
  const logout = useLogout();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-xl bg-surface-search px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      >
        <Avatar name={me.user.name} src={me.user.avatarUrl} size={28} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{me.user.name}</span>
          <span className="block truncate text-2xs text-ink-muted">{me.user.email}</span>
        </span>
        <ChevronDown
          className={cn('h-4 w-4 text-ink-muted transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-line bg-white py-1 shadow-pop"
        >
          <Link
            role="menuitem"
            to="/settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-surface"
          >
            <Settings className="h-4 w-4 text-ink-muted" aria-hidden /> Settings
          </Link>
          {me.isAdmin && (
            <a
              role="menuitem"
              href="/admin/queues"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-surface"
            >
              <LayoutDashboard className="h-4 w-4 text-ink-muted" aria-hidden /> Queue dashboard
            </a>
          )}
          <button
            role="menuitem"
            type="button"
            onClick={() =>
              logout.mutate(undefined, {
                onSuccess: () => navigate('/login', { replace: true }),
                onError: () => toast.error('Logout failed'),
              })
            }
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-red-600 hover:bg-red-50"
          >
            <LogOut className="h-4 w-4" aria-hidden /> Log out
          </button>
        </div>
      )}
    </div>
  );
}

function NavItem({
  to,
  icon,
  label,
  count,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'flex h-[26px] items-center gap-2.5 rounded-lg px-3 py-[17px] text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400',
          isActive ? 'bg-brand-100 font-semibold text-ink' : 'text-ink-soft hover:bg-surface',
        )
      }
    >
      <span className="text-ink-soft">{icon}</span>
      <span className="flex-1">{label}</span>
      {count !== undefined && <span className="text-2xs font-normal text-ink-muted">{count}</span>}
    </NavLink>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const counts = useCounts().data;
  return (
    <aside
      className="flex h-full w-[184px] shrink-0 flex-col gap-2 bg-white px-[5px] pt-3"
      onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate?.()}
    >
      <Link to="/scheduled" className="mb-3 px-2">
        <Logo />
      </Link>
      <ProfileMenu />
      <Link
        to="/compose"
        className="mt-1 flex h-[34px] items-center justify-center rounded-lg border border-brand-500 text-[13px] font-medium text-brand-600 transition-colors hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      >
        Compose
      </Link>
      <nav aria-label="Mailboxes" className="mt-4 flex flex-col gap-0.5">
        <span className="mb-1 px-3 text-2xs font-medium uppercase tracking-wide text-ink-faint">Core</span>
        <NavItem
          to="/scheduled"
          icon={<Clock className="h-4 w-4" />}
          label="Scheduled"
          count={counts?.scheduled}
        />
        <NavItem to="/sent" icon={<Send className="h-4 w-4" />} label="Sent" count={counts?.sent} />
        <span className="mb-1 mt-4 px-3 text-2xs font-medium uppercase tracking-wide text-ink-faint">
          Account
        </span>
        <NavItem to="/settings" icon={<Settings className="h-4 w-4" />} label="Settings" />
      </nav>
    </aside>
  );
}

export function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);

  return (
    <div className="flex min-h-screen bg-white">
      <div className="sticky top-0 hidden h-screen md:block">
        <Sidebar />
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/20"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative h-full w-[200px] shadow-pop">
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2 md:hidden">
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setMobileOpen(true)}
            className="rounded p-1 hover:bg-surface"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
          <Logo className="text-xl" />
        </div>
        <Outlet />
      </div>
    </div>
  );
}
