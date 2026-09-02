/** @file One well-formed gke/profile.json body, and its placement, for tests that read the GKE profile. */

/** Placement the fixture profile assigns to capacity and application Pods. */
export const PLACEMENT = {
  nodeSelector: { "moltzap.dev/pool": "agents" },
  tolerations: [
    {
      key: "moltzap.dev/agents",
      operator: "Equal",
      value: "true",
      effect: "NoSchedule",
    },
  ],
} as const;

/** Serialized gke/profile.json body that decodes into a complete GKE profile. */
export const PROFILE_SOURCE = JSON.stringify({
  apiVersion: "moltzap.gke-profile/v1",
  cluster: { contextEnvironment: "MOLTZAP_KUBE_CONTEXT" },
  rosterPlacement: {
    applyTo: ["aggregateWorkloadPodSets", "sandboxPodTemplates"],
    ...PLACEMENT,
  },
  ledger: {
    active: {
      kind: "empty-dir",
      volume: { name: "ledger", emptyDir: {} },
      mountPath: "/var/lib/moltzap/ledger",
      permissionsInitContainer: true,
    },
    retained: {
      kind: "gcs-fuse-csi-ephemeral",
      bucketEnvironment: "MOLTZAP_GKE_ARTIFACT_BUCKET",
      podAnnotations: { "gke-gcsfuse/volumes": "true" },
      volume: {
        name: "artifacts",
        csi: {
          driver: "gcsfuse.csi.storage.gke.io",
          readOnly: false,
          volumeAttributes: {
            mountOptions: "uid=1000,gid=1000,file-mode=0640,dir-mode=0750",
          },
        },
      },
      mountPath: "/var/lib/moltzap-artifacts",
      directoryTemplate: "/var/lib/moltzap-artifacts/{runNamespace}/ledger",
      publicationOrder: ["manifest.json", "records.ndjson", "completion.json"],
    },
  },
});
