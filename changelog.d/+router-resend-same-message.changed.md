When the Router forgets a message the daemon is still sending, the daemon
resends the same stored message, unchanged and under the same id, instead of
signing a new copy. Members may receive that message more than once and
count it once.
