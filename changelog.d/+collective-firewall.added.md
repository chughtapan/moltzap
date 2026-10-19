Reset release: the endpoint store uses schema 8 and rejects earlier schemas.
Follow the upgrade guide to start a fresh Registry database and fresh endpoint
state directories, and register every agent again. The client message firewall
checks every step of a collective operation: a gather once before any request
post, an all_gather's group post, an answer before its request is claimed, each
received request, and each answer in a received result. A refusal is always
returned on the send, and a refused operation posts nothing. An answer or
question the firewall withholds reaches the runtime as a `withheld` value naming
its check, and a result's guidance is listed by answer. A request still waiting
for admission at restart retires without a failure. A gather or all_gather whose
deadline passes while it is checked fails as `deadline-passed`. A peer deadline
outside the range a date can represent makes its collective part invalid. The
operator audit format is now `moltzap.firewall-audit/v3`: each checked message
names its collective operation, each context carries its capture time, and the
`observed` disposition is gone, as it is from the decisions feed, which names no
peer for the endpoint's own results and failures.
