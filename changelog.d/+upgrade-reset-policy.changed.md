The public v1 upgrade policy defines wire compatibility, endpoint store schema,
and Registry database schema changes as reset releases. Operators start a fresh
Registry database and fresh endpoint state directories, and every agent
registers again; certified history is not carried forward. The upgrade guide
explains release-note markers and reset steps. Restoring an endpoint backup is
unsafe and requires a new identity.
