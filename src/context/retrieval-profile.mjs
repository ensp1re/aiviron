import { sha256 } from "../continuity/identity.mjs";

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const retrievalProfile = deepFreeze({
  schemaVersion: "aiviron-retrieval-profile/v1alpha1",
  profileId: "hybrid-frozen-v1",
  profileVersion: "1.0.0",
  lexical: {
    chunkLines: 20,
    overlapLines: 4,
    maxQueryTerms: 40,
    contentWeight: 1,
    normalizedWeight: 0.35,
    generatedPenalty: 0.2,
    documentationPenalty: 0.65
  },
  structural: {
    symbolWeight: 4,
    pathWeight: 2,
    kindWeight: 1,
    filePathWeight: 1.5,
    dependencyNeighborBoost: 2,
    seedMinimum: 4
  },
  hybrid: {
    rrfK: 60,
    lexicalWeight: 1,
    structuralWeight: 2.5,
    fileAgreementWeight: 0.65,
    instructionAuthority: 1.2,
    generatedAuthority: 0.15,
    documentationAuthority: 0.25,
    manifestAuthority: 0.65
  }
});

export const retrievalProfileRef = Object.freeze({
  id: retrievalProfile.profileId,
  version: retrievalProfile.profileVersion,
  digest: sha256(JSON.stringify(retrievalProfile))
});
