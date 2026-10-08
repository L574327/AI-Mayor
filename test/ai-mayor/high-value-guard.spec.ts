import { HighValueGuard, isHighValueFacility, HIGH_VALUE_PLACEMENT_COOLDOWN_HOURS } from "../../src/main/services/ai-mayor/v2/high-value-guard";
import { mayDemolishFacility } from "../../src/main/services/ai-mayor/v2/district-utilities";
import { GAME_HOUR_FRAMES } from "../../src/main/services/ai-mayor/v2/game-clock";

const at = (hours: number, cycle = 0) => ({ frame: 1_000_000 + Math.round(hours * GAME_HOUR_FRAMES), cycle });

describe("costly facilities are never placed and taken down in a loop", () => {
  it("knows the costly kinds and leaves the cheap ones alone", () => {
    for (const name of ["RecyclingCenter01", "IncinerationPlant01", "SmallCoalPowerPlant01", "WastewaterTreatmentPlant01", "Landfill01", "Hospital01"]) expect(isHighValueFacility(name)).toBe(true);
    for (const name of ["WindTurbine01", "WaterPumpingStation01", "SewageOutlet01", "EU_ResidentialLow01_L4_3x6", "OfficeLowSignature01"]) expect(isHighValueFacility(name)).toBe(false);
    expect(mayDemolishFacility("RecyclingCenter01")).toBe(false);
    expect(mayDemolishFacility("WindTurbine01")).toBe(true);
  });

  it("allows one costly placement a game day, whatever the kind; cheap ones are never held", () => {
    const guard = new HighValueGuard();
    expect(guard.blocked("RecyclingCenter01", at(0))).toBeNull();
    guard.placed("RecyclingCenter01", at(0));
    expect(guard.blocked("IncinerationPlant01", at(3))).toMatch(/^HIGH_VALUE_COOLDOWN/);
    expect(guard.blocked("WindTurbine01", at(3))).toBeNull();
    expect(guard.blocked("IncinerationPlant01", at(HIGH_VALUE_PLACEMENT_COOLDOWN_HOURS + 0.1))).toBeNull();
  });

  it("holds a kind while one of it stands stranded, and frees it once joined", () => {
    const guard = new HighValueGuard();
    guard.stranded("RecyclingCenter01", at(0));
    expect(guard.blocked("RecyclingCenter02", at(48))).toMatch(/^HIGH_VALUE_STRANDED/);
    expect(guard.blocked("IncinerationPlant01", at(48))).toBeNull();
    guard.joined("RecyclingCenter");
    expect(guard.blocked("RecyclingCenter02", at(48))).toBeNull();
  });

  it("survives a restart, and an older save loaded (the clock went back) clears the clocks", () => {
    const guard = new HighValueGuard();
    guard.placed("Landfill01", at(10));
    const again = new HighValueGuard(guard.snapshot());
    expect(again.blocked("Landfill01", at(12))).toMatch(/^HIGH_VALUE_COOLDOWN/);
    expect(again.blocked("Landfill01", at(1))).toBeNull();
  });
});
