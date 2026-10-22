`AuthenticatedHttp.verifyAgentRequest` and the Registry's bootstrap
admission copy caller-supplied body bytes by index, so a byte array with its
own iterator is read as its bytes instead of making the check die.
