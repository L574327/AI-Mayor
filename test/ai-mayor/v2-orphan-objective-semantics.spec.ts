/**
 * `orphan` is a diagnostic, not a connectivity verdict.
 *
 * The engine's own building electricity graph treats an orphaned connector node
 * as the NORMAL state: `ElectricityBuildingGraphSystem.FindMarkerNodes` keeps
 * orphaned nodes as marker nodes and skips the rest, and
 * `GenerateNodesSystem.CreateNodesJob` tags every newly created node with
 * `Game.Net.Orphan`. A building's utility connector is therefore orphaned even
 * while it is genuinely connected.
 *
 * The connection objective is decided by the three topology facts that actually
 * mean "connected": the connector is attached, its flow graph is connected, and
 * the target network is reachable.
 */
import {
  matchCablePrimitiveEffect,
  matchConnectionObjective,
  topologyReachedApprovedContact,
} from "../../src/main/services/ai-mayor/v2/utility-topology-matchers";
import { reacquireAdmittedCourseTerminal } from "../../src/main/services/ai-mayor/v2/utility-target-binding";
import { matchUtilityCableTopology } from "../../src/main/services/ai-mayor/v2/main-adapter";
import { inspectUtilityConnectorResidue } from "../../src/main/services/ai-mayor/v2/durable-clean-baseline";

const topology = (connector: Record<string, unknown>, target: Record<string, unknown> = {}) => ({
  binding: { bindingStatus: "VALID", complete: true, truncated: false },
  connector,
  targetNetwork: { complete: true, truncated: false, networkConnected: true, targetNetworkReachable: true, ...target },
});

const attached = (overrides: Record<string, unknown> = {}) => ({
  entity: { index: 185275, version: 1 },
  attached: true, networkConnected: true, orphan: true, physicalEdges: [], ...overrides,
});

describe("connection objective treats orphan as diagnostic only", () => {
  test("A. attached + networkConnected + targetNetworkReachable with orphan=true is COMPLETE", () => {
    expect(matchConnectionObjective({ topology: topology(attached({ orphan: true })) })).toMatchObject({
      status: "COMPLETE", networkConnected: true, targetNetworkReachable: true, orphan: true,
    });
  });

  test("B. the same topology with orphan=false is COMPLETE", () => {
    expect(matchConnectionObjective({ topology: topology(attached({ orphan: false })) })).toMatchObject({
      status: "COMPLETE", networkConnected: true, targetNetworkReachable: true, orphan: false,
    });
  });

  test("C. attached=false is INCOMPLETE regardless of orphan", () => {
    expect(matchConnectionObjective({ topology: topology(attached({ attached: false, orphan: true })) })).toMatchObject({ status: "INCOMPLETE" });
    expect(matchConnectionObjective({ topology: topology(attached({ attached: false, orphan: false })) })).toMatchObject({ status: "INCOMPLETE" });
  });

  test("D. networkConnected=false is INCOMPLETE", () => {
    expect(matchConnectionObjective({ topology: topology(attached({ networkConnected: false })) })).toMatchObject({ status: "INCOMPLETE", networkConnected: false });
  });

  test("E. targetNetworkReachable=false is INCOMPLETE", () => {
    expect(matchConnectionObjective({ topology: topology(attached(), { targetNetworkReachable: false }) })).toMatchObject({
      status: "INCOMPLETE", networkConnected: true, targetNetworkReachable: false,
    });
  });

  test("F. an absent orphan read is reported UNKNOWN, never fabricated, and never decides the objective", () => {
    const connector = attached();
    delete connector.orphan;
    // Not fabricated into a verdict: the missing read stays UNKNOWN...
    expect(matchConnectionObjective({ topology: topology(connector) })).toMatchObject({ status: "COMPLETE", orphan: "UNKNOWN" });
    // ...and a connector whose attached/network facts are absent is still INCOMPLETE.
    const silent = attached({ attached: false });
    delete silent.orphan;
    expect(matchConnectionObjective({ topology: topology(silent) })).toMatchObject({ status: "INCOMPLETE", orphan: "UNKNOWN" });
  });

  test("orphan never appears as an inferred connectivity verdict in the matcher output", () => {
    const withOrphan = (value: unknown) => {
      const connector = attached();
      if (value === "ABSENT") delete connector.orphan; else connector.orphan = value;
      return matchConnectionObjective({ topology: topology(connector) });
    };
    expect(withOrphan(true).status).toBe("COMPLETE");
    expect(withOrphan(false).status).toBe("COMPLETE");
    expect(withOrphan("ABSENT").status).toBe("COMPLETE");
  });
});

describe("durable clean baseline agrees with the objective matcher about orphan", () => {
  test("an unread orphan does not force an UNKNOWN residue verdict", () => {
    expect(inspectUtilityConnectorResidue({
      type: "electricity", node: { index: 328132, version: 9 }, attached: false, connectedEdges: [],
    }, "generation-1")).toMatchObject({ status: "CLEAN", diagnostics: { orphan: "UNKNOWN" } });
  });

  test("an orphaned but empty connector is still CLEAN", () => {
    expect(inspectUtilityConnectorResidue({
      type: "electricity", node: { index: 328132, version: 9 }, attached: false, orphan: true, connectedEdges: [],
    }, "generation-1")).toMatchObject({ status: "CLEAN", diagnostics: { orphan: true } });
  });
});

describe("the existing split cable chain is already delivered", () => {
  // The live world: one submitted course, split by the engine into two permanent
  // Low-voltage Ground Cable segments running from the facility connector
  // (185275:1) to the certified target road start node (187126:1).
  const cableAction = {
    type: "build_road" as const, prefab: "Low-voltage Ground Cable",
    x1: -1117.83313, z1: -11.0255737, x2: -1247.55188, z2: -12.3875341,
  };
  const segmentA = {
    entity: { index: 192398, version: 1 }, prefab: cableAction.prefab, permanent: true, temp: false, deleted: false,
    start: { x: -1117.83313, z: -11.0255737 }, end: { x: -1182.6925, z: -11.7065535 },
    startNode: { index: 190102, version: 1 }, endNode: { index: 190087, version: 1 },
  };
  const segmentB = {
    entity: { index: 192399, version: 1 }, prefab: cableAction.prefab, permanent: true, temp: false, deleted: false,
    start: { x: -1182.6925, z: -11.7065535 }, end: { x: -1247.55212, z: -12.3875341 },
    startNode: { index: 190087, version: 1 }, endNode: { index: 190101, version: 1 },
  };
  const live = {
    binding: { bindingStatus: "VALID", complete: true, truncated: false },
    connector: {
      entity: { index: 185275, version: 1 }, attached: true, networkConnected: true, orphan: true,
      physicalEdges: [{ ...segmentA, incidentNode: { index: 185275, version: 1 } }],
    },
    targetNetwork: { complete: true, truncated: false, networkConnected: true, targetNetworkReachable: true },
    candidateScan: { complete: true, truncated: false, edges: [segmentA, segmentB], matchingEdges: [] },
  };

  test("G. the two permanent segments are an OBSERVED_MATCH for the single admitted course", () => {
    const result = matchCablePrimitiveEffect({ topology: live, action: cableAction, connector: { index: 185275, version: 1 } });
    expect(result).toMatchObject({ decision: "OBSERVED_MATCH" });
    expect(result.evidence.matchedEdgeIds).toEqual(["192398:1", "192399:1"]);
    expect(result.evidence.matchedNodeIds).toEqual(["190102:1", "190087:1", "190101:1"]);
  });

  test("G. the production cable-topology reconciliation reports MATCH, so no duplicate course is submitted", () => {
    expect(matchUtilityCableTopology({ topology: live, action: cableAction, target: { index: 187126, version: 1 } }))
      .toMatchObject({ result: "MATCH" });
  });

  test("G. the same world now satisfies the connection objective, with orphan left as evidence", () => {
    expect(matchConnectionObjective({ topology: live })).toMatchObject({
      status: "COMPLETE", networkConnected: true, targetNetworkReachable: true, orphan: true,
    });
  });
});

/**
 * A pipe slice's service entry is its own admitted course, and its reachability
 * must be read in the pipe family.
 *
 * The Bridge resolves a target edge's flow family from the edge's OWN nodes, and
 * every road node carries an `ElectricityNodeConnection`. Asking a water read
 * about the certified road therefore fills the target set with ELECTRICITY flow
 * nodes, which a water-pipe walk can never reach — reachability comes back false
 * however continuous the pipe is. The live water world showed exactly that:
 * against the certified road the answer was false with the road's endpoints
 * labelled ELECTRICITY and `waterPipeFlowNode: null`, while against the pipe's
 * own terminal edge at the SAME approved contact the answer was true, 0 m away.
 */
describe("the pipe family's service entry is its own admitted course", () => {
  const CONTACT = { x: 38.61565, z: 1389.81421 };
  const pipe = (index: number, start: { x: number; z: number }, end: { x: number; z: number }) => ({
    entity: { index, version: 1 }, prefab: "Small Water Pipe", start, end,
  });
  const MIDPOINT = { x: -95.14667, z: 1344.692 };
  const CONNECTOR = { x: -228.909, z: 1299.57007 };
  const liveCourse = [pipe(195163, CONNECTOR, MIDPOINT), pipe(195164, MIDPOINT, CONTACT)];

  test("the course's terminal edge is the one carrying the approved contact", () => {
    expect(reacquireAdmittedCourseTerminal({
      edges: liveCourse, prefab: "Small Water Pipe", approvedContact: CONTACT,
    })).toMatchObject({ status: "YES", edge: { entity: { index: 195164, version: 1 } }, contactEnd: "end" });
  });

  test("another prefab at the same contact is not this course", () => {
    expect(reacquireAdmittedCourseTerminal({
      edges: [...liveCourse, { ...pipe(186610, CONTACT, { x: 46.6, z: 1390.1 }), prefab: "Medium Road" }],
      prefab: "Small Water Pipe", approvedContact: CONTACT,
    }).status).toBe("YES");
  });

  test("two course edges at the contact prove nothing", () => {
    expect(reacquireAdmittedCourseTerminal({
      edges: [...liveCourse, pipe(195165, CONTACT, { x: 60, z: 1400 })],
      prefab: "Small Water Pipe", approvedContact: CONTACT,
    }).status).toBe("AMBIGUOUS");
  });

  test("no course edge at the contact proves nothing", () => {
    expect(reacquireAdmittedCourseTerminal({
      edges: [pipe(195163, CONNECTOR, MIDPOINT)], prefab: "Small Water Pipe", approvedContact: CONTACT,
    }).status).toBe("NO");
  });

  test("reachability only counts an endpoint that is the WATER_PIPE node at the contact", () => {
    const reached = (endpoint: Record<string, unknown>) => ({
      binding: { bindingStatus: "VALID", complete: true, truncated: false },
      connector: { attached: true, networkConnected: true, orphan: true, physicalEdges: [] },
      targetNetwork: {
        complete: true, truncated: false, networkConnected: true, targetNetworkReachable: true,
        target: { endpoints: [endpoint] },
      },
    });
    // The pipe's own terminal node, exactly at the approved contact.
    expect(topologyReachedApprovedContact(reached({
      role: "end", node: { index: 186908, version: 1 }, position: { x: CONTACT.x, y: 377.407, z: CONTACT.z },
      utility: "WATER_PIPE", electricityFlowNode: null, waterPipeFlowNode: { index: 183177, version: 1 },
    }), CONTACT)).toBe(true);
    // The same point, but the road node the Bridge resolves first: ELECTRICITY.
    expect(topologyReachedApprovedContact(reached({
      role: "start", node: { index: 50428, version: 1 }, position: { x: CONTACT.x, y: 377.05, z: CONTACT.z },
      utility: "ELECTRICITY", electricityFlowNode: { index: 179849, version: 1 }, waterPipeFlowNode: null,
    }), CONTACT)).toBe(false);
    // A WATER_PIPE node somewhere else is not this course's entry.
    expect(topologyReachedApprovedContact(reached({
      role: "end", node: { index: 186599, version: 1 }, position: { x: MIDPOINT.x, y: 374.46, z: MIDPOINT.z },
      utility: "WATER_PIPE", electricityFlowNode: null, waterPipeFlowNode: { index: 183175, version: 1 },
    }), CONTACT)).toBe(false);
    // No endpoints at all never reads as reached.
    expect(topologyReachedApprovedContact({ targetNetwork: { target: {} } }, CONTACT)).toBe(false);
  });
});
