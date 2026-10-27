# Project-to-node placement: optional and fail-closed

This is an **opt-in coordinator configuration**, not a claim that every
ChatGPT Project automatically supplies its identity. The live swy1
coordinator owns public OAuth, state and routing; gateway is an optional,
independent compute/execution peer. Neither development nor robotics depends
on gateway being online.

The default is `cluster.projectBindings: []`. Keep that default unless a
project really needs a **hard** node pin:

```json
{
  "cluster": {
    "projectBindings": [
      {
        "project": "robotics",
        "node": "swy1",
        "pathPrefix": "/home/swy/ros2_ws"
      }
    ]
  }
}
```

Merge the field into the existing coordinator config; do **not** replace the
whole config, OAuth keys, placement rules or workspaces with this example.
Use the actual verified node aliases and allowed paths before activation.
A binding restricts new workspace opening by project/path/node. An explicit
`node` override cannot violate it; an unknown/offline/draining node, path
outside its advertised roots, or ambiguous rule fails closed. Existing
workspace IDs continue to route to their original owning peer.

For noncritical, optional gateway compute choose an explicit node only when
its advertised root matches, or use an appropriately scoped
`cluster.placementRules` entry with `mode: "prefer"`. **Do not** put
Synrex's primary development project in a hard gateway binding: unlike a
preference, a binding deliberately does not fall back when that node is
offline. Device access and ROS2 operations remain with their physical
owner, rather than following a ChatGPT conversation title.

The standard MCP metadata does not automatically expose ChatGPT Project
membership. The caller may pass `project` when opening a workspace, and
longest-prefix matching can select a binding when it is omitted. Never infer
project identity from an untrusted chat title.

Verification: `src/multinode/placement.test.ts`,
`src/multinode/topology-config.test.ts`, and a live MCP smoke test against
the real registered nodes. No deployment or config mutation is implied by
this document.
