{#-
  One release section of CHANGELOG.md, below the heading towncrier writes from
  title_format: a `### <Type>` heading per fragment type, a `- ` bullet per
  fragment, and a closing blank line before the previous release. Each
  fragment's line breaks fold into spaces so that towncrier's `wrap` refills it
  with two-space continuation lines, and its issue numbers go before its final
  period, as in `(#1187).`
-#}
{% for category, definition in definitions.items() if category in sections[""] %}

### {{ definition.name }}

{% for text, issues in sections[""][category].items() %}
{% set paragraph = text.split() | join(" ") %}
{% if issues and paragraph.endswith(".") %}
- {{ paragraph[:-1] }} ({{ issues | join(", ") }}).
{% elif issues %}
- {{ paragraph }} ({{ issues | join(", ") }})
{% else %}
- {{ paragraph }}
{% endif %}
{% endfor %}
{% endfor %}
{{ "\n" }}
