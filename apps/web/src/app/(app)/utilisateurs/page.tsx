'use client';

/**
 * Utilisateurs et roles — V1 §17, V2 §7, §8.
 *
 * LES PERMISSIONS SONT DECRITES EN LANGAGE METIER.
 *   « orders.change_status » ne veut rien dire pour un commercant. Le catalogue
 *   des permissions vient donc du serveur avec un libelle, une description et
 *   un marqueur « sensible » ; l'ecran les affiche groupees par domaine.
 *
 * LE ROLE PROPRIETAIRE EST IMMUABLE.
 *   Autoriser la modification de ses permissions permettrait a un proprietaire
 *   de se verrouiller hors de sa propre boutique. Le serveur le refuse ; l'UI
 *   le montre desactive plutot que de laisser tenter puis echouer.
 *
 * RIEN N'EST GARANTI PAR CET ECRAN.
 *   Ce que l'interface affiche ou masque est un confort. Toute autorisation est
 *   verifiee cote serveur a chaque appel.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { PERMISSIONS } from '@ecomflow/shared';
import { api, ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { PageHeader } from '@/components/app-shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorState,
  Input,
  LoadingState,
  Select,
  Textarea,
  formatDate,
  formatRelative,
} from '@/components/ui';

interface Member {
  readonly id: string;
  readonly status: string;
  readonly invitedAt: string | null;
  readonly joinedAt: string | null;
  readonly createdAt: string;
  readonly role: { id: string; code: string; name: string; isSystem: boolean };
  readonly user: {
    id: string;
    email: string;
    fullName: string;
    status: string;
    lastLoginAt: string | null;
    phoneVerifiedAt: string | null;
  };
}

interface Role {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly immutable: boolean;
  readonly permissions: readonly string[];
  readonly memberCount: number;
}

interface PermissionDescriptor {
  readonly key: string;
  readonly group: string;
  readonly label: string;
  readonly description: string;
  readonly sensitive: boolean;
}

export default function UsersPage() {
  const t = useTranslations('users');
  const tCommon = useTranslations('common');
  const { can, user: currentUser } = useSession();
  const queryClient = useQueryClient();

  const canManageUsers = can(PERMISSIONS.USERS_MANAGE);
  const canManageRoles = can(PERMISSIONS.ROLES_MANAGE);

  const [tab, setTab] = useState<'members' | 'roles'>('members');
  const [showInvite, setShowInvite] = useState(false);
  const [invite, setInvite] = useState({ email: '', fullName: '', roleId: '' });
  const [provisionalPassword, setProvisionalPassword] = useState<string | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState<Member | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(
    null,
  );

  const membersQuery = useQuery({
    queryKey: ['users', 'members'],
    queryFn: () => api.get<Member[]>('/users'),
  });

  const rolesQuery = useQuery({
    queryKey: ['users', 'roles'],
    queryFn: () => api.get<Role[]>('/roles'),
  });

  const catalogQuery = useQuery({
    queryKey: ['users', 'permissions'],
    queryFn: () => api.get<PermissionDescriptor[]>('/roles/permissions'),
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['users'] });
  }

  const inviteMutation = useMutation({
    mutationFn: () => api.post<{ provisionalPassword?: string }>('/users/invite', invite),
    onSuccess: (result) => {
      setShowInvite(false);
      setInvite({ email: '', fullName: '', roleId: '' });
      // Le mot de passe provisoire n'est retourne qu'UNE fois : il n'est
      // stocke nulle part en clair, l'administrateur doit le transmettre.
      setProvisionalPassword(result.provisionalPassword ?? null);
      setFeedback({ tone: 'success', text: t('invited') });
      refresh();
    },
    onError: (caught) => {
      setFeedback({
        tone: 'danger',
        text: caught instanceof ApiError ? caught.userMessage : t('inviteFailed'),
      });
    },
  });

  const roleChangeMutation = useMutation({
    mutationFn: (payload: { membershipId: string; roleId: string }) =>
      api.patch(`/users/${payload.membershipId}/role`, { roleId: payload.roleId }),
    onSuccess: () => {
      setFeedback({ tone: 'success', text: t('roleUpdated') });
      refresh();
    },
    onError: (caught) => {
      setFeedback({
        tone: 'danger',
        text: caught instanceof ApiError ? caught.userMessage : t('roleRefused'),
      });
    },
  });

  const statusMutation = useMutation({
    mutationFn: (payload: { membershipId: string; action: 'deactivate' | 'reactivate' }) =>
      api.post(`/users/${payload.membershipId}/${payload.action}`, {}),
    onSuccess: () => {
      setConfirmDeactivate(null);
      refresh();
    },
    onError: (caught) => {
      setConfirmDeactivate(null);
      setFeedback({
        tone: 'danger',
        text: caught instanceof ApiError ? caught.userMessage : t('actionRefused'),
      });
    },
  });

  function submitInvite(event: FormEvent) {
    event.preventDefault();
    inviteMutation.mutate();
  }

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          canManageUsers && tab === 'members' ? (
            <Button size="sm" onClick={() => setShowInvite((value) => !value)}>
              {showInvite ? tCommon('close') : t('invite')}
            </Button>
          ) : null
        }
      />

      {feedback ? (
        <div className="mb-3">
          <Alert tone={feedback.tone === 'success' ? 'success' : 'danger'}>{feedback.text}</Alert>
        </div>
      ) : null}

      {provisionalPassword ? (
        <div className="mb-3">
          <Alert tone="warning" title={t('provisionalTitle')}>
            <p className="text-sm">
              {t('provisionalHint')}
            </p>
            <p className="mt-1.5 font-mono text-base font-semibold">{provisionalPassword}</p>
            <button
              className="mt-1.5 text-xs underline"
              onClick={() => setProvisionalPassword(null)}
            >
              {t('provisionalAck')}
            </button>
          </Alert>
        </div>
      ) : null}

      <div className="mb-3 flex rounded-md border border-slate-300 bg-white p-0.5 sm:max-w-xs">
        {(
          [
            ['members', 'tabMembers'],
            ['roles', 'tabRoles'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={
              tab === value
                ? 'flex-1 rounded bg-brand-600 px-2.5 py-1 text-xs font-medium text-white'
                : 'flex-1 rounded px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100'
            }
          >
            {t(label)}
          </button>
        ))}
      </div>

      {/* --- Invitation ----------------------------------------------------- */}
      {showInvite && canManageUsers ? (
        <Card title={t('inviteTitle')} className="mb-3">
          <form onSubmit={submitInvite} className="grid gap-3 sm:grid-cols-3">
            <Input
              label={t('email')}
              type="email"
              required
              value={invite.email}
              onChange={(event) => setInvite({ ...invite, email: event.target.value })}
              placeholder="agent@boutique.dz"
              hint={t('emailHint')}
            />
            <Input
              label={t('fullName')}
              required
              value={invite.fullName}
              onChange={(event) => setInvite({ ...invite, fullName: event.target.value })}
              placeholder={t('fullNamePlaceholder')}
            />
            <Select
              label={t('role')}
              required
              value={invite.roleId}
              onChange={(event) => setInvite({ ...invite, roleId: event.target.value })}
            >
              <option value="">{tCommon('select')}</option>
              {rolesQuery.data?.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </Select>

            <div className="sm:col-span-3">
              <Button type="submit" loading={inviteMutation.isPending}>
                {t('sendInvite')}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {/* --- Membres --------------------------------------------------------- */}
      {tab === 'members' ? (
        <Card padded={false}>
          {membersQuery.isLoading ? (
            <LoadingState />
          ) : membersQuery.error ? (
            <ErrorState
              message={
                membersQuery.error instanceof ApiError
                  ? membersQuery.error.userMessage
                  : tCommon('loadFailed')
              }
              onRetry={() => void membersQuery.refetch()}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('columns.member')}</th>
                    <th>{t('columns.role')}</th>
                    <th>{t('columns.state')}</th>
                    <th>{t('columns.lastLogin')}</th>
                    <th>{t('columns.since')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {membersQuery.data?.map((member) => {
                    const isSelf = member.user.id === currentUser?.id;

                    return (
                      <tr key={member.id}>
                        <td>
                          <p className="font-medium text-slate-800">
                            {member.user.fullName}
                            {isSelf ? (
                              <span className="ms-1.5 text-xs text-slate-400">{t('you')}</span>
                            ) : null}
                          </p>
                          <p className="text-xs text-slate-500">{member.user.email}</p>
                        </td>
                        <td>
                          {canManageUsers && !isSelf ? (
                            <select
                              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
                              value={member.role.id}
                              disabled={roleChangeMutation.isPending}
                              onChange={(event) =>
                                roleChangeMutation.mutate({
                                  membershipId: member.id,
                                  roleId: event.target.value,
                                })
                              }
                            >
                              {rolesQuery.data?.map((role) => (
                                <option key={role.id} value={role.id}>
                                  {role.name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <Badge tone="info">{member.role.name}</Badge>
                          )}
                        </td>
                        <td>
                          <Badge tone={member.status === 'ACTIVE' ? 'success' : 'neutral'}>
                            {member.status === 'ACTIVE'
                              ? t('stateActive')
                              : member.status === 'INVITED'
                                ? t('stateInvited')
                                : t('stateDisabled')}
                          </Badge>
                          {member.user.phoneVerifiedAt ? null : (
                            <span
                              className="ms-1.5 text-xs text-warning"
                              title={t('phoneUnverifiedTooltip')}
                            >
                              {t('phoneUnverified')}
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap text-xs text-slate-500">
                          {member.user.lastLoginAt
                            ? formatRelative(member.user.lastLoginAt)
                            : tCommon('never')}
                        </td>
                        <td className="whitespace-nowrap text-xs text-slate-500">
                          {formatDate(member.joinedAt ?? member.createdAt)}
                        </td>
                        <td className="text-end">
                          {canManageUsers && !isSelf ? (
                            member.status === 'ACTIVE' ? (
                              <button
                                className="text-xs text-slate-500 hover:text-danger"
                                onClick={() => setConfirmDeactivate(member)}
                              >
                                {t('deactivate')}
                              </button>
                            ) : (
                              <button
                                className="text-xs text-brand-700 hover:underline"
                                onClick={() =>
                                  statusMutation.mutate({
                                    membershipId: member.id,
                                    action: 'reactivate',
                                  })
                                }
                              >
                                {t('reactivate')}
                              </button>
                            )
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : (
        <RolesPanel
          roles={rolesQuery.data ?? []}
          catalog={catalogQuery.data ?? []}
          canManage={canManageRoles}
          loading={rolesQuery.isLoading || catalogQuery.isLoading}
          onChanged={(text) => {
            setFeedback({ tone: 'success', text });
            refresh();
          }}
          onError={(text) => setFeedback({ tone: 'danger', text })}
        />
      )}

      <ConfirmDialog
        open={confirmDeactivate !== null}
        title={t('deactivateTitle', { name: confirmDeactivate?.user.fullName ?? '' })}
        message={t('deactivateWarning')}
        confirmLabel={t('deactivate')}
        danger
        loading={statusMutation.isPending}
        onCancel={() => setConfirmDeactivate(null)}
        onConfirm={() =>
          confirmDeactivate
            ? statusMutation.mutate({
                membershipId: confirmDeactivate.id,
                action: 'deactivate',
              })
            : undefined
        }
      />
    </>
  );
}

function RolesPanel({
  roles,
  catalog,
  canManage,
  loading,
  onChanged,
  onError,
}: {
  roles: readonly Role[];
  catalog: readonly PermissionDescriptor[];
  canManage: boolean;
  loading: boolean;
  onChanged: (text: string) => void;
  onError: (text: string) => void;
}) {
  const t = useTranslations('users');
  const tCommon = useTranslations('common');
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [showCreate, setShowCreate] = useState(false);
  const [newRole, setNewRole] = useState({ name: '', description: '' });

  const updateMutation = useMutation({
    mutationFn: (payload: { roleId: string; permissions: string[] }) =>
      api.patch(`/roles/${payload.roleId}/permissions`, { permissions: payload.permissions }),
    onSuccess: () => {
      setEditingRoleId(null);
      onChanged(t('permissionsUpdated'));
    },
    onError: (caught) => {
      onError(caught instanceof ApiError ? caught.userMessage : t('permissionsRefused'));
    },
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.post('/roles', {
        name: newRole.name,
        description: newRole.description.trim() || undefined,
        permissions: [...draft],
      }),
    onSuccess: () => {
      setShowCreate(false);
      setNewRole({ name: '', description: '' });
      setDraft(new Set());
      onChanged(t('roleCreated'));
    },
    onError: (caught) => {
      onError(caught instanceof ApiError ? caught.userMessage : t('roleCreateFailed'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (roleId: string) => api.delete(`/roles/${roleId}`),
    onSuccess: () => onChanged(t('roleDeleted')),
    onError: (caught) => {
      onError(caught instanceof ApiError ? caught.userMessage : t('roleDeleteFailed'));
    },
  });

  if (loading) return <LoadingState />;

  const groups = [...new Set(catalog.map((entry) => entry.group))];

  function toggle(key: string) {
    const next = new Set(draft);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setDraft(next);
  }

  return (
    <div className="space-y-3">
      {canManage ? (
        <Card title={t('createRole')}>
          {showCreate ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  label={t('roleName')}
                  required
                  value={newRole.name}
                  onChange={(event) => setNewRole({ ...newRole, name: event.target.value })}
                  placeholder={t('roleNamePlaceholder')}
                />
                <Textarea
                  label={t('roleDescription')}
                  rows={2}
                  value={newRole.description}
                  onChange={(event) => setNewRole({ ...newRole, description: event.target.value })}
                />
              </div>

              <PermissionPicker
                catalog={catalog}
                groups={groups}
                selected={draft}
                onToggle={toggle}
              />

              <div className="flex gap-2">
                <Button
                  loading={createMutation.isPending}
                  disabled={!newRole.name.trim() || draft.size === 0}
                  onClick={() => createMutation.mutate()}
                >
                  {t('createRoleSubmit')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setShowCreate(false);
                    setDraft(new Set());
                  }}
                >
                  {tCommon('cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setShowCreate(true);
                setEditingRoleId(null);
                setDraft(new Set());
              }}
            >
              {t('newRole')}
            </Button>
          )}
        </Card>
      ) : null}

      {roles.map((role) => (
        <Card
          key={role.id}
          title={
            <span className="flex items-center gap-2">
              {role.name}
              {role.isSystem ? <Badge tone="neutral">{t('system')}</Badge> : null}
              {role.immutable ? <Badge tone="info">{t('immutable')}</Badge> : null}
              <span className="text-xs font-normal text-slate-500">
                {t('memberCount', { count: role.memberCount })}
              </span>
            </span>
          }
          action={
            canManage && !role.immutable ? (
              editingRoleId === role.id ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    loading={updateMutation.isPending}
                    onClick={() =>
                      updateMutation.mutate({ roleId: role.id, permissions: [...draft] })
                    }
                  >
                    {tCommon('save')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingRoleId(null)}>
                    {tCommon('cancel')}
                  </Button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setEditingRoleId(role.id);
                      setShowCreate(false);
                      setDraft(new Set(role.permissions));
                    }}
                  >
                    {t('edit')}
                  </Button>
                  {!role.isSystem && role.memberCount === 0 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => deleteMutation.mutate(role.id)}
                    >
                      {t('delete')}
                    </Button>
                  ) : null}
                </div>
              )
            ) : null
          }
        >
          {role.description ? (
            <p className="mb-2 text-sm text-slate-600">{role.description}</p>
          ) : null}

          {role.immutable ? (
            <Alert tone="info">
              {t('immutableNote')}
            </Alert>
          ) : null}

          {editingRoleId === role.id ? (
            <PermissionPicker
              catalog={catalog}
              groups={groups}
              selected={draft}
              onToggle={toggle}
            />
          ) : (
            <div className="flex flex-wrap gap-1">
              {role.permissions.length === 0 ? (
                <span className="text-sm text-slate-500">{t('noPermission')}</span>
              ) : (
                role.permissions.map((key) => {
                  const descriptor = catalog.find((entry) => entry.key === key);
                  return (
                    <Badge
                      key={key}
                      tone={descriptor?.sensitive ? 'warning' : 'neutral'}
                      title={descriptor?.description}
                    >
                      {descriptor?.label ?? key}
                    </Badge>
                  );
                })
              )}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function PermissionPicker({
  catalog,
  groups,
  selected,
  onToggle,
}: {
  catalog: readonly PermissionDescriptor[];
  groups: readonly string[];
  selected: Set<string>;
  onToggle: (key: string) => void;
}) {
  const t = useTranslations('users');

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <div key={group}>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{group}</p>
          <div className="mt-1 grid gap-1 sm:grid-cols-2">
            {catalog
              .filter((entry) => entry.group === group)
              .map((entry) => (
                <label
                  key={entry.key}
                  className="flex items-start gap-2 rounded-md px-2 py-1 hover:bg-slate-50"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.has(entry.key)}
                    onChange={() => onToggle(entry.key)}
                  />
                  <span>
                    <span className="text-sm text-slate-800">
                      {entry.label}
                      {entry.sensitive ? (
                        <Badge tone="warning" className="ms-1.5">
                          {t('sensitive')}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="block text-xs text-slate-500">{entry.description}</span>
                  </span>
                </label>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
