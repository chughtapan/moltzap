A send's firewall guidance is set when its check admits it, so every result
of that send carries it: an all_gather whose deadline completes it before its
group post certifies, and a gather, all_gather or answer whose later failure is
delivered inbound, no longer return a result without it. A bound post whose
activation fails now reports `delivery-pending` through its completion, as a
post sent without a firewall does, so this holds there too.
