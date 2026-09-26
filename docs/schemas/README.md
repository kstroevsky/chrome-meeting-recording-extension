# Integration schemas

These schemas describe the receiver-facing ADR-0008 V1 contract. They document
only sanitized external projection fields; internal history, Drive, OPFS,
download, notation, analysis and sharing identifiers are intentionally absent.

The recording snapshot CloudEvent schema leaves the event type prefix open
because the project-controlled domain has not been frozen yet. The runtime
builder requires that prefix explicitly and rejects the ADR placeholder
com.example.

The schema IDs use the reserved .invalid TLD until a project-owned schema
origin is chosen. Consumers should reference the checked-in files by version
rather than treating those placeholder IDs as network locations.
