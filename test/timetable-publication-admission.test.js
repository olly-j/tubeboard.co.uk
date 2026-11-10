import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalResource, PUBLICATION_ASSET_DIRECTORY, readPublicationAsset } from '../server/timetable-publication-resource.js';
import { SOURCE_ARCHIVE_DIRECTORY, loadSourceBodyArchiveIndex } from '../server/timetable-source-body-resource.js';
import { evaluateNewEditionAdmission, hasPreservedPublicationCoverage, publicationResourceSHA256 } from '../server/timetable-publication-admission.js';

const previousSHA = '788955e868b7ae85219db15b4e05c2f187bdf3be1767f16b1c369b60dea08ad7';
const previousProofSHA = '0c5fba0afe99c032a4477fc9126158f26aeafc3ad9fdd173c3d6c489f2fb191c';
const archivePath = path.join(SOURCE_ARCHIVE_DIRECTORY, previousSHA, previousProofSHA);
const now = Date.parse('2026-11-10T20:00:00Z');
const digest = value => createHash('sha256').update(value).digest('hex');

async function candidatePackage(t, { mutateProof = () => {}, omitBody = false } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-publication-admission-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const publicationDirectory = path.join(temp, 'proofs');
  const archiveDirectory = path.join(temp, 'archives');
  const candidateSHA = 'b'.repeat(64);
  const candidateProofSHA = 'a'.repeat(64); // Replaced after exact proof serialization below.
  const previousAsset = await readPublicationAsset(previousSHA);
  const proof = structuredClone(previousAsset.proof);
  proof.publication.sha256 = candidateSHA;
  proof.publication.capturedAt = '2026-11-10T19:50:00Z';
  mutateProof(proof);
  const proofBytes = Buffer.from(JSON.stringify(proof, null, 2) + '\n');
  const actualProofSHA = digest(proofBytes);
  const wrapper = canonicalResource({ schemaVersion: 1, publicationSHA256: candidateSHA, proofRevision: 1,
    proofBodySHA256: actualProofSHA, proofBodyBase64: proofBytes.toString('base64') });
  const candidateDirectory = path.join(publicationDirectory, `${candidateSHA}.json`);
  await fs.mkdir(publicationDirectory, { recursive: true });
  await fs.writeFile(candidateDirectory, wrapper);

  const manifest = JSON.parse(await fs.readFile(path.join(archivePath, 'manifest.json'), 'utf8'));
  manifest.publicationSHA256 = candidateSHA;
  manifest.proofBodySHA256 = actualProofSHA;
  const candidateArchive = path.join(archiveDirectory, candidateSHA, actualProofSHA);
  await fs.mkdir(path.join(candidateArchive, 'bodies'), { recursive: true });
  await fs.writeFile(path.join(candidateArchive, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const [index, source] of manifest.sources.entries()) {
    if (omitBody && index === manifest.sources.length - 1) continue;
    const body = await fs.readFile(path.join(archivePath, source.bodyPath));
    await fs.writeFile(path.join(candidateArchive, source.bodyPath), body);
  }
  const [previousAssetReadback, candidateAsset] = await Promise.all([
    readPublicationAsset(previousSHA), readPublicationAsset(candidateSHA, publicationDirectory)
  ]);
  const comparisonIndex = await loadSourceBodyArchiveIndex({ publicationDirectory, archiveDirectory });
  return { candidateSHA, previousAsset: previousAssetReadback, candidateAsset, comparisonIndex };
}

const observationFor = candidateSHA => ({ schemaVersion: 1,
  source: 'https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip',
  publicationSHA256: candidateSHA, observedAt: '2026-11-10T19:55:00Z', expiresAt: '2026-11-10T20:05:00Z' });

test('complete new edition package is eligible for admission but never activates', async t => {
  const fixture = await candidatePackage(t);
  const result = evaluateNewEditionAdmission({ ...fixture, officialObservation: observationFor(fixture.candidateSHA),
    admissionRevision: 4, ifMatchPreviousResourceSHA256: publicationResourceSHA256(fixture.previousAsset), now });
  assert.deepEqual(result, {
    eligible: true, reason: 'new-edition-package-complete', admissionRevision: 5,
    previousPublicationSHA256: previousSHA, publicationSHA256: fixture.candidateSHA,
    previousResourceSHA256: publicationResourceSHA256(fixture.previousAsset),
    proofRevision: 1, proofBodySHA256: fixture.candidateAsset.identity.proofBodySHA256,
    resourceSHA256: publicationResourceSHA256(fixture.candidateAsset),
    comparisonSourceCount: 31, activatesPublication: false
  });
});

test('same-edition revisions, stale or mismatched observations, and exhausted revision fail closed', async t => {
  const fixture = await candidatePackage(t);
  const base = { ...fixture, officialObservation: observationFor(fixture.candidateSHA), admissionRevision: 4,
    ifMatchPreviousResourceSHA256: publicationResourceSHA256(fixture.previousAsset), now };
  assert.equal(evaluateNewEditionAdmission({ ...base, candidateAsset: fixture.previousAsset }).reason,
    'same-edition-not-admissible');
  assert.equal(evaluateNewEditionAdmission({ ...base, candidateAsset: {
    ...fixture.candidateAsset, identity: { ...fixture.candidateAsset.identity, proofRevision: 2 }
  } }).reason, 'new-edition-must-start-at-revision-one');
  assert.equal(evaluateNewEditionAdmission({ ...base, officialObservation: observationFor(previousSHA) }).reason,
    'official-edition-observation-stale-or-mismatched');
  assert.equal(evaluateNewEditionAdmission({ ...base, admissionRevision: Number.MAX_SAFE_INTEGER }).reason,
    'admission-revision-invalid');
  assert.equal(evaluateNewEditionAdmission({ ...base, ifMatchPreviousResourceSHA256: 'c'.repeat(64) }).reason,
    'previous-publication-precondition-failed');
});

test('previous directional scope and every previously covered operating date must be preserved', async t => {
  const missingDirection = await candidatePackage(t, { mutateProof(proof) {
    const entry = proof.entries.find(value => value.lineID === 'northern' && value.stationID === '940GZZLUGDG');
    entry.directionalDefinitions.pop();
    entry.directionalSourceEvidence.pop();
  } });
  assert.equal(hasPreservedPublicationCoverage(missingDirection.previousAsset, missingDirection.candidateAsset), false);

  const missingDate = await candidatePackage(t, { mutateProof(proof) {
    const entry = proof.entries.find(value => value.status === 'qualified' && value.directionalSourceEvidence?.length);
    const evidence = entry.directionalSourceEvidence[0];
    const profile = entry.directionalDefinitions.find(value => value.direction === evidence.direction).profiles[0];
    for (let time = Date.parse(`${evidence.operatingStartDate}T12:00:00Z`); time <= Date.parse(`${evidence.operatingEndDate}T12:00:00Z`); time += 86_400_000) {
      const date = new Date(time).toISOString().slice(0, 10);
      const weekday = new Date(time).getUTCDay() + 1;
      if (date >= '2026-11-09' && !proof.bankHolidayDates.includes(date) && profile.weekdays.includes(weekday)
          && (profile.originatingServiceDateRanges === undefined
            || profile.originatingServiceDateRanges.some(range => range.startDate <= date && date <= range.endDate))) {
        evidence.originatingDateGaps.push({ serviceDate: date, reason: 'candidate-gap' });
        return;
      }
    }
    assert.fail('fixture needs one previously covered service date');
  } });
  assert.equal(hasPreservedPublicationCoverage(missingDate.previousAsset, missingDate.candidateAsset), false);
  const result = evaluateNewEditionAdmission({ ...missingDate,
    officialObservation: observationFor(missingDate.candidateSHA), admissionRevision: 4,
    ifMatchPreviousResourceSHA256: publicationResourceSHA256(missingDate.previousAsset), now });
  assert.equal(result.reason, 'previous-date-or-direction-coverage-reduced');
});

test('candidate bank-holiday and holiday-calendar bounds cannot erase prior date support', async t => {
  const newlyClosedDate = await candidatePackage(t, { mutateProof(proof) {
    proof.bankHolidayDates.push('2026-11-10');
  } });
  assert.equal(hasPreservedPublicationCoverage(newlyClosedDate.previousAsset, newlyClosedDate.candidateAsset), false);

  const narrowedHolidayCalendar = await candidatePackage(t, { mutateProof(proof) {
    proof.holidayCoverageStart = '2026-11-07';
  } });
  assert.equal(hasPreservedPublicationCoverage(narrowedHolidayCalendar.previousAsset, narrowedHolidayCalendar.candidateAsset), false);
});

test('missing comparison body prevents admission even when the official edition readback matches', async t => {
  const fixture = await candidatePackage(t, { omitBody: true });
  const result = evaluateNewEditionAdmission({ ...fixture,
    officialObservation: observationFor(fixture.candidateSHA), admissionRevision: 4,
    ifMatchPreviousResourceSHA256: publicationResourceSHA256(fixture.previousAsset), now });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'comparison-archive-incomplete');
});
