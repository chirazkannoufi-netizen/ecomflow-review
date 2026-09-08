'use client';

/**
 * Session utilisateur cote navigateur.
 *
 * CE QUE CE CONTEXTE EST — et n'est pas.
 *   Il porte l'identite, la boutique active et les permissions effectives,
 *   uniquement pour ADAPTER L'INTERFACE : masquer un bouton, cacher une entree
 *   de menu, afficher un bandeau d'essai.
 *
 *   Il n'accorde AUCUN droit. Chaque appel est revalide par le serveur, qui
 *   seul fait autorite. Un utilisateur qui modifierait ces valeurs dans sa
 *   console ne gagnerait que des boutons qui echouent en 403.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { api, tokenStore, ApiError } from './api-client';

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly phoneVerified: boolean;
  /** Langue d'interface enregistree pour ce compte. */
  readonly locale?: string;
}

export interface SessionTenant {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
}

export interface AuthSession {
  readonly tokens: {
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: string;
    refreshTokenExpiresAt: string;
  };
  readonly user: SessionUser;
  readonly tenant: SessionTenant | null;
  readonly role: string | null;
  readonly permissions: string[];
  readonly isPlatformAdmin: boolean;
}

interface SessionContextValue {
  readonly user: SessionUser | null;
  readonly tenant: SessionTenant | null;
  readonly role: string | null;
  readonly permissions: ReadonlySet<string>;
  readonly isPlatformAdmin: boolean;
  readonly loading: boolean;
  // Ces membres sont declares comme PROPRIETES de type fonction, et non en
  // methode abregee (`can(p): boolean`). La difference n'est pas cosmetique :
  // la forme methode indique un `this` implicite, alors que ces fonctions sont
  // des fermetures destinees a etre destructurees (`const { can } = ...`).
  /** Vrai si l'interface peut afficher l'action correspondante. */
  readonly can: (permission: string) => boolean;
  readonly canAny: (...permissions: string[]) => boolean;
  readonly login: (email: string, password: string) => Promise<void>;
  readonly logout: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly applySession: (session: AuthSession) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [tenant, setTenant] = useState<SessionTenant | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<ReadonlySet<string>>(new Set());
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  const applySession = useCallback((session: AuthSession) => {
    tokenStore.set(
      session.tokens.accessToken,
      session.tokens.refreshToken,
      session.tenant?.id ?? null,
    );
    setUser(session.user);
    setTenant(session.tenant);
    setRole(session.role);
    setPermissions(new Set(session.permissions));
    setIsPlatformAdmin(session.isPlatformAdmin);
  }, []);

  const clearSession = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    setTenant(null);
    setRole(null);
    setPermissions(new Set());
    setIsPlatformAdmin(false);
  }, []);

  /**
   * Recharge la session depuis le serveur.
   *
   * On ne fait jamais confiance a ce qui est stocke localement pour decider
   * des droits : `/auth/me` renvoie les permissions REELLES, recalculees.
   */
  const refresh = useCallback(async () => {
    if (!tokenStore.getAccessToken()) {
      clearSession();
      setLoading(false);
      return;
    }

    try {
      const [me, profile] = await Promise.all([
        api.get<{
          userId: string;
          tenantId: string | null;
          membershipId: string | null;
          permissions: string[];
          isPlatformAdmin: boolean;
        }>('/auth/me'),
        api
          .get<{ tenant: SessionTenant | null; user: SessionUser }>('/tenants/current')
          .catch(() => null),
      ]);

      setPermissions(new Set(me.permissions));
      setIsPlatformAdmin(me.isPlatformAdmin);

      if (profile) {
        setUser(profile.user);
        setTenant(profile.tenant);
      }
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        clearSession();
      }
    } finally {
      setLoading(false);
    }
  }, [clearSession]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      const session = await api.post<AuthSession>(
        '/auth/login',
        { email, password },
        { anonymous: true },
      );
      applySession(session);
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    const refreshToken = tokenStore.getRefreshToken();
    // La deconnexion cote serveur revoque le jeton ; son echec ne doit pas
    // empecher la deconnexion locale.
    if (refreshToken) {
      await api.post('/auth/logout', { refreshToken }, { anonymous: true }).catch(() => undefined);
    }
    clearSession();
    router.push('/connexion');
  }, [clearSession, router]);

  const can = useCallback(
    (permission: string) => isPlatformAdmin || permissions.has(permission),
    [permissions, isPlatformAdmin],
  );

  const canAny = useCallback(
    (...required: string[]) => isPlatformAdmin || required.some((entry) => permissions.has(entry)),
    [permissions, isPlatformAdmin],
  );

  const value = useMemo<SessionContextValue>(
    () => ({
      user,
      tenant,
      role,
      permissions,
      isPlatformAdmin,
      loading,
      can,
      canAny,
      login,
      logout,
      refresh,
      applySession,
    }),
    [user, tenant, role, permissions, isPlatformAdmin, loading, can, canAny, login, logout, refresh, applySession],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession doit etre utilise a l interieur de <SessionProvider>.');
  }
  return context;
}
