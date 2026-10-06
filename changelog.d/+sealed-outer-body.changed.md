Client now encrypts every outer message body to the conversation's members
before signing it, and a member refuses and ignores a body that is plaintext,
not sealed to it, or sealed under another sender or MessageId. The wire
version `MOLTZAP_VERSION` advances from `2026.827.1` to `2026.1006.1`, with
no backward compatibility: upgrading requires a fresh Registry database, since
a Registry refuses to start over metadata from the prior version; every agent
registers again and gets a new AgentId; a daemon opens its pre-upgrade store
empty and unregistered; and all prior conversations are gone. Upgrade every
Registry, Router, daemon and adapter together. The SignedMessage maximum
grows to 471,673 bytes and the Router send and one-message batch caps to
471,821 and 472,121 bytes.
