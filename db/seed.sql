-- Default roles, applied only when the roles table is empty (see scripts/migrate.ts).
insert into roles (name, description) values
  ('viewer',   'Chat only'),
  ('engineer', 'Chat plus GitHub tools'),
  ('sales',    'Chat plus CRM tools'),
  ('admin',    'Chat, role management and audit log');

insert into role_capabilities (role_id, capability)
select r.id, v.capability
from roles r join (values
  ('viewer', 'chat'),
  ('engineer', 'chat'), ('engineer', 'tool:github'),
  ('sales', 'chat'), ('sales', 'tool:crm'),
  ('admin', 'chat'), ('admin', 'admin:roles'), ('admin', 'admin:audit')
) as v(role, capability) on r.name = v.role;

-- Group names as they appear in Okta (and therefore in SCIM /Groups displayName).
insert into group_role_mappings (group_name, role_id)
select v.group_name, r.id
from roles r join (values
  ('Lab Users', 'viewer'),
  ('Engineering', 'engineer'),
  ('Sales', 'sales'),
  ('Lab Admins', 'admin')
) as v(group_name, role) on r.name = v.role;
