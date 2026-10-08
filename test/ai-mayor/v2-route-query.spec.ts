import { createTargetRouteQueryPorts, normalizeRouteQuery } from "../../src/main/services/ai-mayor/v2/route-query";

const source = { index: 10, version: 1 };
const lane = { index: 20, version: 1 };
const base = { queryId: "q-1", runtimeEpoch: "r-1", nativeSubmitted: true, duplicate: false };
const success = { ...base, state: "ROUTABLE", evidence: { pathOwnerFlags: "Updated", pathElementCount: 2, pathInformation: { origin: source, destination: lane, distance: 12, duration: 3, cost: 4, actualMethods: "Road", state: "Updated" }, resolvedSource: { building: source, lane, delta: .5 }, resolvedTarget: { lane, delta: .2 } } };

describe("V2 native route-query contract", () => {
  test("valid submit returns accepted/pending, never synchronous routable", async () => {
    const ports = createTargetRouteQueryPorts({ runtimeEpoch: "r-1", submit: async () => ({ ...base, state: "ACCEPTED" }), status: async () => ({ ...base, state: "PENDING" }) });
    expect((await ports.submit({ buildingRef: source, targetAnchor: { lane, delta: .2 } })).state).toBe("ACCEPTED");
  });
  test("completed native success is routable", () => expect(normalizeRouteQuery(success, "r-1").state).toBe("ROUTABLE"));
  test("completed Failed is unroutable", () => expect(normalizeRouteQuery({ ...base, state: "UNROUTABLE", evidence: { pathOwnerFlags: "Failed", pathElementCount: 0 } }, "r-1").state).toBe("UNROUTABLE"));
  test("setup ErrorCode is query error, not unroutable", () => expect(normalizeRouteQuery({ ...base, state: "QUERY_ERROR", error: "ErrorCode=MultipleStartResults" }, "r-1").state).toBe("QUERY_ERROR"));
  test("stale source is stale", () => expect(normalizeRouteQuery({ ...base, state: "STALE", error: "source stale" }, "r-1").state).toBe("STALE"));
  test("stale target is stale", () => expect(normalizeRouteQuery({ ...base, state: "STALE", error: "target stale" }, "r-1").state).toBe("STALE"));
  test("duplicate query id does not resubmit", async () => {
    let submits = 0;
    const ports = createTargetRouteQueryPorts({ runtimeEpoch: "r-1", submit: async () => { submits++; return { ...base, state: "ACCEPTED" }; }, status: async () => ({ ...base, state: "PENDING" }) });
    await ports.submit({ queryId: "q-1", buildingRef: source, targetAnchor: { lane, delta: .2 } });
    await ports.submit({ queryId: "q-1", buildingRef: source, targetAnchor: { lane, delta: .2 } });
    expect(submits).toBe(1);
  });
  test("accepted query is re-observed and consumes a terminal status", async () => {
    let submits = 0;
    let statuses = 0;
    const ports = createTargetRouteQueryPorts({
      runtimeEpoch: "r-1",
      submit: async () => { submits++; return { ...base, state: "ACCEPTED" }; },
      status: async () => { statuses++; return { ...success, queryId: "q-accepted", state: "ROUTABLE" }; },
    });
    expect((await ports.submit({ queryId: "q-accepted", buildingRef: source, targetAnchor: { lane, delta: .2 } })).lifecycle)
      .toBe("WAITING_FOR_ROUTE_RESULT");
    const terminal = await ports.submit({ queryId: "q-accepted", buildingRef: source, targetAnchor: { lane, delta: .2 } });
    expect(terminal.state).toBe("ROUTABLE");
    expect(terminal.lifecycle).toBe("ROUTABLE");
    expect(submits).toBe(1);
    expect(statuses).toBe(1);
  });
  test("status rejects a result from another runtime epoch", async () => {
    const ports = createTargetRouteQueryPorts({
      runtimeEpoch: "r-current",
      submit: async () => ({ ...base, state: "ACCEPTED" }),
      status: async () => ({ ...success, runtimeEpoch: "r-old", state: "ROUTABLE" }),
    });
    await ports.submit({ queryId: "q-stale", buildingRef: source, targetAnchor: { lane, delta: .2 } });
    const result = await ports.status("q-stale");
    expect(result.state).toBe("STALE");
    expect(result.lifecycle).toBe("STALE");
  });
  test("resume probes an existing pending native query without resubmitting", async () => {
    let submits = 0;
    const ports = createTargetRouteQueryPorts({
      runtimeEpoch: "r-1",
      resume: true,
      submit: async () => { submits++; return { ...base, queryId: "q-reload", state: "ACCEPTED" }; },
      status: async () => ({ ...base, queryId: "q-reload", state: "PENDING" }),
    });
    const result = await ports.submit({ queryId: "q-reload", buildingRef: source, targetAnchor: { lane, delta: .2 } });
    expect(result.state).toBe("PENDING");
    expect(submits).toBe(0);
  });
  test("pending TTL is represented as expired", () => expect(normalizeRouteQuery({ ...base, state: "EXPIRED" }, "r-1").state).toBe("EXPIRED"));
  test("terminal evidence is retained after owner cleanup", () => expect(normalizeRouteQuery(success, "r-1").evidence?.pathElementCount).toBe(2));
  test("attachment-only evidence cannot become routable", () => expect(normalizeRouteQuery({ ...base, state: "UNAVAILABLE", evidence: { pathOwnerFlags: "", pathElementCount: 0 } }, "r-1").state).toBe("QUERY_ERROR"));
  test("route mode is fixed to Road/Car", () => expect(normalizeRouteQuery(success, "r-1").evidence?.resolvedTarget?.roadType).toBe("Car"));
});
