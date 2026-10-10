# Integration schemas

These schemas describe the receiver-facing ADR-0008 V1 contract. They document
only sanitized external projection fields; internal history, Drive, OPFS,
download, notation, analysis and sharing identifiers are intentionally absent.

The V1 CloudEvent type namespace is frozen as
`io.github.kstroevsky.meeting-recorder`. Official builds do not vary this
namespace by environment, so receivers can route on exact V1 event types.

Schema IDs point at the versioned files in the project's GitHub repository.
Receivers should vendor or pin the V1 schemas they validate against rather than
depending on a network fetch at webhook-processing time.
