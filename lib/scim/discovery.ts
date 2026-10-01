// Static discovery documents (RFC 7643 §5-7). They describe what this server
// actually supports, so IdPs don't send filters or bulk requests we'd reject.

const attr = (name: string, extra: Record<string, unknown> = {}) => ({
  name, type: "string", multiValued: false, required: false, caseExact: false,
  mutability: "readWrite", returned: "default", uniqueness: "none", ...extra,
});

export const serviceProviderConfig = {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
  documentationUri: "https://github.com/martinoyovo/sovereign-aid-assistant/tree/main/access-lab#scim",
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 200 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false }, // meta.version is informational; If-Match isn't enforced
  authenticationSchemes: [
    { type: "oauthbearertoken", name: "Bearer token", description: "Static bearer token shared with the IdP", primary: true },
  ],
  meta: { resourceType: "ServiceProviderConfig", location: "/scim/v2/ServiceProviderConfig" },
};

const userSchema = {
  id: "urn:ietf:params:scim:schemas:core:2.0:User",
  name: "User",
  description: "User account",
  attributes: [
    attr("userName", { required: true, uniqueness: "server" }),
    attr("name", {
      type: "complex",
      subAttributes: [attr("givenName"), attr("familyName")],
    }),
    attr("displayName"),
    attr("externalId", { caseExact: true }),
    attr("active", { type: "boolean" }),
    attr("emails", {
      type: "complex", multiValued: true, required: true,
      subAttributes: [attr("value"), attr("type"), attr("primary", { type: "boolean" })],
    }),
    attr("groups", {
      type: "complex", multiValued: true, mutability: "readOnly",
      subAttributes: [attr("value", { mutability: "readOnly" }), attr("display", { mutability: "readOnly" })],
    }),
  ],
  meta: { resourceType: "Schema", location: "/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:User" },
};

const groupSchema = {
  id: "urn:ietf:params:scim:schemas:core:2.0:Group",
  name: "Group",
  description: "Group of users",
  attributes: [
    attr("displayName", { required: true, uniqueness: "server" }),
    attr("externalId", { caseExact: true }),
    attr("members", {
      type: "complex", multiValued: true,
      subAttributes: [attr("value", { mutability: "immutable" }), attr("display", { mutability: "readOnly" })],
    }),
  ],
  meta: { resourceType: "Schema", location: "/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:Group" },
};

const LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const list = (items: unknown[]) => ({ schemas: [LIST], totalResults: items.length, startIndex: 1, itemsPerPage: items.length, Resources: items });

export const schemas = list([userSchema, groupSchema]);

export const resourceTypes = list([
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
    id: "User", name: "User", endpoint: "/Users", schema: userSchema.id,
    meta: { resourceType: "ResourceType", location: "/scim/v2/ResourceTypes/User" },
  },
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
    id: "Group", name: "Group", endpoint: "/Groups", schema: groupSchema.id,
    meta: { resourceType: "ResourceType", location: "/scim/v2/ResourceTypes/Group" },
  },
]);
