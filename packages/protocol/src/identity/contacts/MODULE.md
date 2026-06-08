# protocol/identity/contacts

_`packages/protocol/src/identity/contacts`_

## Purpose

Contact identity descriptors, RPC descriptors, and notifications.

## Public surface

### [`ContactAcceptedNotificationDefinition`](./contacts.ts#L108)

_Variable_

```ts
export const ContactAcceptedNotificationDefinition = defineNotification({
  name: "contact/accepted",
  params: ContactAcceptedNotificationSchema,
})
```

### [`ContactId`](./ids.ts#L5)

_TypeAlias_

```ts
export type ContactId = string & Brand.Brand<"ContactId">;
```

### [`ContactId`](./ids.ts#L5)

_Variable_

```ts
export type ContactId = string & Brand.Brand<"ContactId">
```

### [`ContactNotFoundError`](./contacts.ts#L30)

_Class_

```ts
export class ContactNotFoundError extends Schema.TaggedError<ContactNotFoundError>()(
  "ContactNotFound",
  errorPayloadFields,
) {
  static readonly message = "Contact not found";
}
```

### [`ContactRequestNotificationDefinition`](./contacts.ts#L103)

_Variable_

```ts
export const ContactRequestNotificationDefinition = defineNotification({
  name: "contact/request",
  params: ContactRequestNotificationSchema,
})
```

### [`ContactsAccept`](./contacts.ts#L79)

_Variable_

```ts
export const ContactsAccept = defineRpc({
  name: "contacts/accept",
  params: Schema.Struct({ contactId: ContactId }),
  result: Schema.Struct({ contact: ContactSchema }),
  requires: [AgentPrincipal],
  errors: [ContactNotFoundError, ForbiddenError, UnauthorizedError],
})
```

### [`ContactsAdd`](./contacts.ts#L68)

_Variable_

```ts
export const ContactsAdd = defineRpc({
  name: "contacts/add",
  params: Schema.Struct({
    contactUserId: UserId,
    relationship: Schema.optional(Schema.String),
  }),
  result: Schema.Struct({ contact: ContactSchema }),
  requires: [AgentPrincipal],
  errors: [ForbiddenError, ConflictError, UnauthorizedError],
})
```

### [`ContactsById`](./contacts.ts#L87)

_Variable_

```ts
export const ContactsById = defineRpc({
  name: "contacts/byId",
  params: Schema.Struct({ contactId: ContactId }),
  result: Schema.Struct({ contact: ContactSchema }),
  requires: [AgentPrincipal],
  errors: [ContactNotFoundError, UnauthorizedError],
})
```

### [`ContactsList`](./contacts.ts#L54)

_Variable_

```ts
export const ContactsList = defineRpc({
  name: "contacts/list",
  params: Schema.Struct({
    limit: ListLimitSchema,
    cursor: Schema.optional(listCursorSchema()),
  }),
  result: Schema.Struct({
    contacts: Schema.Array(ContactSchema),
    nextCursor: Schema.optional(listCursorSchema()),
  }),
  requires: [AgentPrincipal],
  errors: [InvalidParamsError, UnauthorizedError],
})
```

### [`NotInContactsError`](./contacts.ts#L23)

_Class_

```ts
export class NotInContactsError extends Schema.TaggedError<NotInContactsError>()(
  "NotInContacts",
  errorPayloadFields,
) {
  static readonly message = "Recipient blocks unsolicited contacts";
}
```

## Files

- `contacts.ts`
- `ids.ts`
