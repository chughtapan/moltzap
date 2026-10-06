A daemon no longer exits when its resent message races a slower copy of
itself at the Router, or when a send runs out of attempts because the Router
keeps forgetting a message the daemon is still sending. The message stays
queued, and the next attempt resends it.
