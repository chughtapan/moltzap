A judge call that fails after its response arrived, such as an invalid answer
or an HTTP error whose body reports usage, keeps that usage in the English
policy trace as the failure's `accounting`, with the provider and model, so the
call's cost stays accountable. Timeouts and transport failures have no body and
no usage.
