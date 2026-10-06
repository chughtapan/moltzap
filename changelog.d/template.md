{#-
  One release section of CHANGELOG.md: the version heading, a `### <Type>`
  heading per fragment type, a `- ` bullet per fragment, and a closing blank
  line before the previous release. With no fragments it renders nothing, so
  such a release leaves CHANGELOG.md unchanged. Each fragment's line breaks
  fold into spaces so that towncrier's `wrap` refills it with two-space
  continuation lines, and its issue numbers go before its final period, as in
  `(#<number>).`
-#}
{% if sections[""] %}
## [{{ versiondata.version }}] - {{ versiondata.date }}
{% for category, definition in definitions.items() if category in sections[""] %}

### {{ definition.name }}

{% for text, issues in sections[""][category].items() %}
{% set paragraph = text.split() | join(" ") %}
{% set stop = "." if paragraph.endswith(".") else "" %}
- {{ paragraph.removesuffix(stop) }}{% if issues %} ({{ issues | join(", ") }}){% endif %}{{ stop }}
{% endfor %}
{% endfor %}
{{ "\n" }}{% endif %}
