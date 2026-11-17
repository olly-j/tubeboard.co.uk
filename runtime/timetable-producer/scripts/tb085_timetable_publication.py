#!/usr/bin/env python3
"""Qualify current TfL origin timetables against a publisher's TransXChange ZIP.

Generalises the retained calendar-20260927/qualify_timetable.py research without
Northern pins. Reads an already downloaded official archive and bounded API
captures; never downloads a large archive on-device or promotes arrivals to
outgoing clocks. Full ordered paths, repeated stops and duplicate rows survive
fingerprinting. Missing captures/calendars/parity remain explicit gaps.

Example:
  python3 scripts/tb085_timetable_publication.py --archive /private/current.zip \
    --capture-dir /private/captures --output TubeBoardShared/timetable-publication.json

Capture directory supplies publication-download.json (body metadata),
bank-holidays.body (official GOV.UK JSON), line-station-matrix.json and each
record's timetableSource.body. Additional bounded records may be supplied in
extra-line-station-matrix.json. XML origin-only scope is deliberate; intermediate
stop departure offsets are never inferred. Runtime must recheck publication
identity, API row parity, calendar, freshness, line and station closures.
"""
from __future__ import annotations
import argparse
import copy
from contextlib import contextmanager
import tempfile
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile
from zoneinfo import ZoneInfo

NS = {'t': 'http://www.transxchange.org.uk/'}
SOURCE_URL = 'https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip'
MAX_ORIGIN_INVENTORY_BYTES = 2 * 1024 * 1024
# At most one disjoint inclusive range per date in the existing two-year horizon.
MAX_NEGATIVE_CALENDAR_DAYS = 731
LINE_NAMES = {'Bakerloo':'bakerloo','Central':'central','Circle':'circle','District':'district',
 'Hammersmith & City':'hammersmith-city','Jubilee':'jubilee','Metropolitan':'metropolitan',
 'Northern':'northern','Piccadilly':'piccadilly','Victoria':'victoria','Waterloo & City':'waterloo-city','DLR':'dlr'}
RAIL = {'elizabeth','liberty','lioness','mildmay','suffragette','weaver','windrush'}
WEEKDAYS = {'Sunday':1,'Monday':2,'Tuesday':3,'Wednesday':4,'Thursday':5,'Friday':6,'Saturday':7}
DAY_GROUPS = {**{n:{d} for n,d in WEEKDAYS.items()},'MondayToFriday':{2,3,4,5,6},
 'MondayToSunday':{1,2,3,4,5,6,7},'Weekend':{1,7},'MondayToSaturday':{2,3,4,5,6,7}}
API_DAYS = {'Monday - Thursday':{2,3,4,5},'Monday - Friday':{2,3,4,5,6},'Monday to Friday':{2,3,4,5,6},
 'Saturday (also Good Friday)':{7},'Saturdays and Public Holidays':{7},'Saturday':{7},'Sunday':{1},
 **{n:{d} for n,d in WEEKDAYS.items()},**{n+'s':{d} for n,d in WEEKDAYS.items()}}

def published_line(name, tram_platforms):
    return 'tram' if name == 'Tram' and tram_platforms else LINE_NAMES.get(name)


def local_tag(element): return element.tag.rsplit('}',1)[-1]
def txc_station(stop: str) -> str:
    """Convert observed TfL directional points to station IDs, never platforms."""
    if stop in {'9400ZZBPSUST','9400ZZNEUGST'}: return stop.replace('9400','940G',1)
    match = re.fullmatch(r'9400ZZ(LU|DL)([A-Z0-9]+)[1-9]',stop)
    if match: return '940GZZ'+match[1]+match[2]
    raise ValueError('unmapped directional stop '+stop)

def key(minute: int, path: list[str]) -> str:
    if not 0 <= minute < 2880 or not path: raise ValueError('invalid service clock/path')
    return f'{minute:04d}|'+'>'.join(path)

def logical_key(raw: str) -> str:
    """Equate adjacent timing intervals, preserving every nonadjacent revisit."""
    clock, path = raw.split('|', 1)
    logical = []
    for station in path.split('>'):
        if not logical or logical[-1] != station:
            logical.append(station)
    return clock + '|' + '>'.join(logical)

def fingerprint(rows: list[str]) -> dict:
    return {'count':len(rows),'sha256':hashlib.sha256('\n'.join(sorted(rows)).encode('ascii')).hexdigest()}

def profile_days(profile: ET.Element | None) -> set[int]:
    if profile is None: raise ValueError('missing calendar')
    # Unknown special dates, school calendars and service exceptions are withheld.
    allowed = {'RegularDayType','BankHolidayOperation'}
    if any(local_tag(child) not in allowed for child in profile): raise ValueError('unqualified calendar exception')
    days = profile.find('t:RegularDayType/t:DaysOfWeek',NS)
    if days is None: raise ValueError('missing regular days')
    result=set()
    for child in days:
        if local_tag(child) not in DAY_GROUPS: raise ValueError('unqualified weekday '+local_tag(child))
        result |= DAY_GROUPS[local_tag(child)]
    if not result: raise ValueError('empty calendar')
    return result

def effective_calendar(journey, pattern, service, *, bank_holiday_country=None) -> dict:
    """TXC property overrides: journey > pattern > service, never whole-profile fallback."""
    properties={}
    for owner in (service, pattern, journey):
        if owner is None:continue
        profiles=owner.findall('t:OperatingProfile',NS)
        if len(profiles)>1:raise ValueError('duplicate operating profile')
        if not profiles:continue
        seen=set()
        for child in profiles[0]:
            name=local_tag(child)
            if (name not in {'RegularDayType','SpecialDaysOperation','BankHolidayOperation'} or name in seen
                    or child.tag!='{'+NS['t']+'}'+name):
                raise ValueError('unqualified calendar exception')
            seen.add(name);properties[name]=child
    regular=ET.Element('OperatingProfile')
    if 'RegularDayType' in properties:
        value=properties['RegularDayType']
        if value.attrib or len(value)!=1 or value[0].tag!='{'+NS['t']+'}DaysOfWeek' or value[0].attrib:
            raise ValueError('unqualified regular calendar')
        if any(c.attrib or len(c) or c.tag!='{'+NS['t']+'}'+local_tag(c) for c in value[0]):
            raise ValueError('unqualified regular calendar')
        regular.append(value)
    days=profile_days(regular)
    result={'weekdays':days}
    excluded=[]
    special=properties.get('SpecialDaysOperation')
    if special is not None:
        if special.attrib or [c.tag for c in special]!=['{'+NS['t']+'}DaysOfNonOperation']:
            raise ValueError('unqualified calendar exception')
        container=special[0]
        if container.attrib or not 1<=len(container)<=MAX_NEGATIVE_CALENDAR_DAYS:
            raise ValueError('calendar range count exceeds bounded date horizon')
        for item in container:
            if item.tag!='{'+NS['t']+'}DateRange' or item.attrib or [c.tag for c in item]!=['{'+NS['t']+'}StartDate','{'+NS['t']+'}EndDate']:
                raise ValueError('unqualified calendar exception')
            start,end=(c.text or '' for c in item)
            if any(c.attrib or len(c) for c in item):raise ValueError('unqualified calendar exception')
            if not all(re.fullmatch(r'\d{4}-\d{2}-\d{2}',d) for d in (start,end)):
                raise ValueError('invalid calendar date range')
            first,last=date.fromisoformat(start),date.fromisoformat(end)
            if not 0<=(last-first).days<=730:raise ValueError('invalid calendar date range')
            excluded.append({'startDate':start,'endDate':end})
        excluded.sort(key=lambda r:r['startDate'])
        if (date.fromisoformat(excluded[-1]['endDate'])-date.fromisoformat(excluded[0]['startDate'])).days>=MAX_NEGATIVE_CALENDAR_DAYS:
            raise ValueError('calendar date horizon exceeds two years')
        if any(a['endDate']>=b['startDate'] for a,b in zip(excluded,excluded[1:])):
            raise ValueError('overlapping calendar date ranges')
        result['nonOperationDateRanges']=excluded
    bank=properties.get('BankHolidayOperation')
    named_gaps=set()
    # Actual bank holidays are withheld by the existing global holiday fence.
    # Ordinary named dates must not be mistaken for already-withheld holidays.
    holidays={'GoodFriday','LateSummerBankHolidayNotScotland','MayDay','EasterMonday','SpringBank'}
    nominal={'ChristmasEve':'12-24','NewYearsEve':'12-31','ChristmasDay':'12-25',
             'BoxingDay':'12-26','NewYearsDay':'01-01'}
    if bank is not None:
        seen=set()
        for operation in bank:
            kind=local_tag(operation)
            if bank.attrib or operation.attrib or kind not in {'DaysOfOperation','DaysOfNonOperation'} or kind in seen or operation.tag!='{'+NS['t']+'}'+kind:
                raise ValueError('unqualified bank holiday operation')
            seen.add(kind);names=set()
            for day in operation:
                name=local_tag(day)
                if day.attrib or len(day) or (day.text or '').strip() or name in names or day.tag!='{'+NS['t']+'}'+name:
                    raise ValueError('unqualified bank holiday operation')
                names.add(name)
                if name=='AllBankHolidays':
                    # TXC: holidays in the country where this service runs,
                    # not a union of regional UK holidays or ordinary Eves.
                    if bank_holiday_country!='england-and-wales':
                        raise ValueError('unqualified AllBankHolidays country')
                    named_gaps.update({'01-01','12-25','12-26'})
                elif name in nominal:
                    # Nominal fixed holidays can differ from observed substitute
                    # dates in the England/Wales holiday feed. Withhold both.
                    named_gaps.add(nominal[name])
                elif name not in holidays:raise ValueError('unqualified bank holiday operation')
    if named_gaps:result['unsupportedNamedCalendarDates']=sorted(named_gaps)
    return result


def row_operates_on(row: dict, civil: str) -> bool:
    """Exceptions bind the originating date, including 24+ hour departures."""
    return (row['start']<=civil<=row['end']
            and date.fromisoformat(civil).isoweekday()%7+1 in row['weekdays']
            and not any(r['startDate']<=civil<=r['endDate'] for r in row.get('nonOperationDateRanges',[])))


def row_calendar_gap(row: dict, civil: str) -> bool:
    # Explicit negative dates take precedence; positive ordinary named holiday
    # semantics remain unqualified instead of silently becoming weekdays.
    return (row['start']<=civil<=row['end'] and civil[5:] in row.get('unsupportedNamedCalendarDates',[])
            and not any(r['startDate']<=civil<=r['endDate'] for r in row.get('nonOperationDateRanges',[])))


def row_service_windows(row: dict) -> list[tuple]:
    if not row.get('nonOperationDateRanges') and not row.get('unsupportedNamedCalendarDates'):
        return [(row['start'],row['end'],tuple(sorted(row['weekdays'])))]
    first,last=date.fromisoformat(row['start']),date.fromisoformat(row['end'])
    if not 0<=(last-first).days<=730:raise ValueError('unsupported calendar inventory horizon')
    windows=[];begin=None;previous=None
    for offset in range((last-first).days+1):
        civil=(first+timedelta(days=offset)).isoformat()
        withheld=(row_calendar_gap(row,civil) or any(r['startDate']<=civil<=r['endDate']
                                                   for r in row.get('nonOperationDateRanges',[])))
        if withheld:
            if begin is not None:windows.append((begin,previous,tuple(sorted(row['weekdays']))));begin=None
        elif begin is None:begin=civil
        previous=civil
    if begin is not None:windows.append((begin,previous,tuple(sorted(row['weekdays']))))
    return windows


def pattern_paths(root: ET.Element) -> dict[str,list[tuple[str,str]]]:
    # Activity is part of the boundary evidence, not an inferred stop class.
    known={'pickUp','pickUpAndSetDown','setDown','pass'}
    sections={}
    for section in (root._sections() if hasattr(root,'_sections') else root.findall('.//t:JourneyPatternSection',NS)):
        path=[]
        for link in section.findall('t:JourneyPatternTimingLink',NS):
            start=(link.findtext('t:From/t:StopPointRef',namespaces=NS),link.findtext('t:From/t:Activity',namespaces=NS))
            end=(link.findtext('t:To/t:StopPointRef',namespaces=NS),link.findtext('t:To/t:Activity',namespaces=NS))
            if any(not stop or activity not in known for stop,activity in (start,end)):
                raise ValueError('unknown/missing calling activity')
            if path and path[-1] != start:raise ValueError('disconnected or contradictory timing boundary')
            if not path:path.append(start)
            path.append(end)
        ident=section.attrib.get('id')
        if not ident or not path or ident in sections:raise ValueError('invalid section identity')
        sections[ident]=path
    patterns={}
    for pattern in root.findall('.//t:StandardService/t:JourneyPattern',NS):
        path=[]
        for ref in (pattern.findtext('t:JourneyPatternSectionRefs',namespaces=NS) or '').split():
            if ref not in sections:raise ValueError('missing pattern section')
            segment=sections[ref]
            if path and path[-1]!=segment[0]:raise ValueError('contradictory pattern sections')
            path.extend(segment if not path else segment[1:])
        ident=pattern.attrib.get('id')
        if not ident or not path or ident in patterns:raise ValueError('invalid pattern identity')
        patterns[ident]=path
    return patterns

def pattern_timing_links(root: ET.Element, pattern_id: str) -> list[ET.Element]:
    """Load only an annotated journey's validated pattern, never every tree.

    pattern_paths still validates all sections/patterns first. No-override
    journeys retain their existing lack of a timing-link ID requirement.
    """
    pattern=next(p for p in root.findall('.//t:StandardService/t:JourneyPattern',NS)
                 if p.attrib['id']==pattern_id)
    links=[]
    for ref in (pattern.findtext('t:JourneyPatternSectionRefs',namespaces=NS) or '').split():
        section=(root._section_by_id(ref) if hasattr(root,'_section_by_id') else
                 root.find(".//t:JourneyPatternSection[@id='"+ref+"']",NS))
        links.extend(section.findall('t:JourneyPatternTimingLink',NS))
    return links

def validate_display_only_overrides(journey: ET.Element, links: list[ET.Element]) -> None:
    """Accept only retained-shaped, reference-scoped display annotations.

    Annotation text never supplies a clock, stop, activity, destination or via.
    Base-pattern calling paths and API/calendar parity remain authoritative.
    Every timing/stop/wait override or unrecognised structure is rejected.
    """
    namespace='{'+NS['t']+'}'
    overrides=[child for child in journey if local_tag(child)=='VehicleJourneyTimingLink']
    if not overrides:return
    ids=[link.attrib.get('id') for link in links]
    if any(not ident or ident!=ident.strip() for ident in ids) or len(set(ids))!=len(ids):
        raise ValueError('ambiguous pattern link identity for journey override')
    scoped=set(ids);seen=set();override_ids=set()
    def container(element):
        return not (element.text or '').strip() and all(not (child.tail or '').strip() for child in element)
    def leaf(element):
        return not element.attrib and not list(element) and bool((element.text or '').strip())
    for override in overrides:
        if override.tag!=namespace+'VehicleJourneyTimingLink' or set(override.attrib)-{'id'} or not container(override):
            raise ValueError('unsupported journey timing override')
        ident=override.attrib.get('id')
        if ident is not None:
            if not ident or ident!=ident.strip() or ident in override_ids:raise ValueError('invalid journey override identity')
            override_ids.add(ident)
        children=list(override);tags=[child.tag for child in children]
        permitted=[[namespace+'JourneyPatternTimingLinkRef',namespace+side] for side in ['From','To']]
        permitted.append([namespace+'JourneyPatternTimingLinkRef',namespace+'From',namespace+'To'])
        if tags not in permitted or not leaf(children[0]):raise ValueError('unsupported journey timing override structure')
        ref=children[0].text.strip()
        if ref not in scoped or ref in seen:raise ValueError('foreign or duplicate journey override reference')
        seen.add(ref)
        for usage in children[1:]:
            if usage.attrib or not container(usage) or len(usage)!=1:
                raise ValueError('unsupported journey timing override usage')
            display=usage[0]
            if display.tag!=namespace+'DynamicDestinationDisplay' or not leaf(display):
                raise ValueError('unsupported journey timing override display')

# Match the existing cached-source/window archive budget, independently for
# each seekable temporary file; a limit failure never truncates evidence.
MAX_TEMPORARY_BYTES = 256 * 1024 * 1024


def _record_bytes(element):
    # A record's tail belongs to its parent, not the standalone XML document.
    # Preserve every child tail used by strict override/usage validation.
    detached=copy.copy(element)
    detached.tail=None
    return ET.tostring(detached,encoding='utf-8')


def _write_spool(store, payload):
    if store.tell() + len(payload) > MAX_TEMPORARY_BYTES:
        raise ValueError('temporary timetable spool exceeds 256 MiB')
    store.write(payload)


class _ProjectionRoot(ET.Element):
    """Element-compatible root with internal disk-backed record iterators."""


class _OriginProjection:
    """Keep origin-validator inputs, without retaining unused timing geometry."""
    def __init__(self, selected=False, journey_store=None):
        self.selected = selected
        self.journey_store = journey_store
        self.journey_markers = {}
        self.section_markers = {}
        self.root = None
        self.stack = []
        self.builder = None
        self.record_depth = None
        self.full_record = False
        self.full_depth = None
        namespace = '{' + NS['t'] + '}'
        self.section = namespace + 'JourneyPatternSection'
        self.link = namespace + 'JourneyPatternTimingLink'
        self.records = {namespace + name for name in ('Service', 'StandardService', 'VehicleJourney', 'JourneyPatternSection')}
        self.sides = {namespace + 'From', namespace + 'To'}
        self.leaves = {namespace + 'StopPointRef', namespace + 'Activity'}

    def start(self, tag, attributes):
        depth = len(self.stack) + 1
        parent = self.stack[-1][0] if self.stack else None
        kept = False
        if depth == 1:
            self.root = _ProjectionRoot(tag, attributes)
        elif self.builder is None:
            if tag in self.records:
                self.builder = ET.TreeBuilder()
                self.record_depth = depth
                self.full_record = self.selected or tag != self.section
                kept = True
        elif self.full_record or self.full_depth is not None:
            kept = True
        else:
            kept = (tag in self.records or tag == self.link and parent == self.section
                    or tag in self.sides and parent == self.link or tag in self.leaves and parent in self.sides)
            if kept and (tag in self.records and tag != self.section or tag in self.leaves):
                # Keep complete leaves too: nested text/tail must retain the
                # exact findtext semantics of malformed or annotated input.
                self.full_depth = depth
        if kept:
            self.builder.start(tag, attributes)
        self.stack.append((tag, kept))

    def data(self, text):
        if self.builder is not None and self.stack[-1][1]:
            self.builder.data(text)

    def end(self, tag):
        depth = len(self.stack)
        _, kept = self.stack.pop()
        if kept:
            self.builder.end(tag)
        if self.full_depth == depth:
            self.full_depth = None
        if self.record_depth == depth:
            record = self.builder.close()
            # Malformed nesting can contribute to global metadata queries too.
            # Retain such records intact so their duplicate/reference errors
            # remain visible before journey validation, exactly as before.
            nested_metadata = any(node.tag in self.records - {'{' + NS['t'] + '}VehicleJourney'}
                                  for node in record.iter() if node is not record)
            if self.journey_store is not None and not nested_metadata and (local_tag(record) == 'VehicleJourney'
                    or local_tag(record) == 'JourneyPatternSection'):
                payload = _record_bytes(record)
                self.journey_store.seek(0, 2)
                offset = self.journey_store.tell()
                _write_spool(self.journey_store, payload)
                marker = ET.Element(record.tag, record.attrib)
                markers = self.section_markers if local_tag(record) == 'JourneyPatternSection' else self.journey_markers
                markers[marker] = (offset, len(payload))
                self.root.append(marker)
            else:
                self.root.append(record)
            self.builder = None
            self.record_depth = None
            self.full_record = False

    def close(self):
        return self.root


def _file_sha256(path):
    digest=hashlib.sha256()
    with path.open('rb') as source:
        while block := source.read(64 * 1024):digest.update(block)
    return digest.hexdigest()


def _read_projection(source, selected=False, journey_store=None):
    target = _OriginProjection(selected=selected, journey_store=journey_store)
    parser = ET.XMLParser(target=target)
    digest = hashlib.sha256()
    while block := source.read(64 * 1024):
        digest.update(block)
        parser.feed(block)
    return parser.close(), digest.hexdigest(), target.journey_markers, target.section_markers


def _read_origin_projection(source):
    root, digest, _, _ = _read_projection(source)
    return root, digest


@contextmanager
def _streamed_projection(source, selected=False):
    # Seekable disk storage bounds retained journey trees without changing
    # any calendar/override fields or their document traversal order.
    with tempfile.TemporaryFile(mode='w+b') as store:
        root, digest, markers, section_markers = _read_projection(source, selected, store)
        def load(location):
            offset, length = location
            store.seek(offset)
            return ET.fromstring(store.read(length))
        def sections():
            for element in root.iter('{' + NS['t'] + '}JourneyPatternSection'):
                if element in section_markers:
                    yield from load(section_markers[element]).iter('{' + NS['t'] + '}JourneyPatternSection')
                else:
                    yield element
        # Keep only marker/element references, not reconstructed section trees.
        # First-match lookup also preserves the existing invalid-member fallback.
        section_index={}
        for element in root.iter('{' + NS['t'] + '}JourneyPatternSection'):
            section_index.setdefault(element.attrib.get('id'),element)
        def section_by_id(ident):
            element=section_index.get(ident)
            return load(section_markers[element]) if element in section_markers else element
        def journeys():
            # A malformed-but-well-formed nested journey is still visited and
            # validated, including journeys inside a spooled section/record.
            for element in root.iter():
                if element in markers or element in section_markers:
                    yield from load((markers if element in markers else section_markers)[element]).iter('{' + NS['t'] + '}VehicleJourney')
                elif element.tag == '{' + NS['t'] + '}VehicleJourney':
                    yield element
        root._sections = sections
        root._section_by_id = section_by_id
        root._record_store = store
        iterator = journeys()
        try:
            yield root, digest, iterator
        finally:
            iterator.close()
            # The section closure captures root. Break that cycle explicitly,
            # including unsupported-line/validation exits before consumption.
            del root._sections
            del root._section_by_id
            del root._record_store


@contextmanager
def _nested_archive(path):
    with zipfile.ZipFile(path) as outer:
        nested = [name for name in outer.namelist()
                  if name.startswith('LULDLRTRAMRIVERCABLE FULL ') and name.endswith('.zip')]
        if len(nested) != 1:
            raise ValueError('expected one official LUL/DLR archive')
        if outer.getinfo(nested[0]).file_size > MAX_TEMPORARY_BYTES:
            raise ValueError('nested timetable archive exceeds 256 MiB')
        with tempfile.TemporaryFile(mode='w+b') as stored:
            with outer.open(nested[0]) as source:
                while block := source.read(64 * 1024):
                    _write_spool(stored, block)
            stored.seek(0)
            with zipfile.ZipFile(stored) as inner:
                yield inner


def xml_origin_rows(data: bytes, member: str, tram_platforms=None) -> tuple[list[dict], dict]:
    with _streamed_projection(io.BytesIO(data)) as (root, raw_sha, journeys):
        return _origin_rows_from_projection(root, raw_sha, member, tram_platforms, journeys)


def _origin_rows_from_projection(root, raw_sha, member, tram_platforms=None, journeys=None):

    services=root.findall('.//t:Service',NS)
    if len(services)!=1:raise ValueError('unexpected service count')
    service=services[0];names=[e.text for e in service.findall('t:Lines/t:Line/t:LineName',NS)]
    line = published_line(names[0], tram_platforms) if len(names) == 1 else None
    if line is None:return [],{}
    station_for_stop = tram_platforms.__getitem__ if line == 'tram' else txc_station
    start=service.findtext('t:OperatingPeriod/t:StartDate',namespaces=NS);end=service.findtext('t:OperatingPeriod/t:EndDate',namespaces=NS)
    if not start or not end or date.fromisoformat(start)>date.fromisoformat(end):raise ValueError('invalid operating period')
    paths=pattern_paths(root);rows=[]
    calendar_patterns={p.attrib.get('id'):p for p in service.findall('t:StandardService/t:JourneyPattern',NS)}
    for journey in (root.findall('.//t:VehicleJourney',NS) if journeys is None else journeys):
        path=paths[journey.findtext('t:JourneyPatternRef',namespaces=NS)]
        if path[0][1] not in {'pickUp','pickUpAndSetDown'}:
            raise ValueError('non-passenger VehicleJourney origin activity')
        if path[-1][1] not in {'setDown','pickUpAndSetDown'}:
            raise ValueError('VehicleJourney destination lacks set-down activity')
        if any(local_tag(child)=='VehicleJourneyTimingLink' for child in journey):
            validate_display_only_overrides(journey,pattern_timing_links(root,journey.findtext('t:JourneyPatternRef',namespaces=NS)))
        clock=journey.findtext('t:DepartureTime',namespaces=NS)
        hh,mm,ss=map(int,clock.split(':'));shift=int(journey.findtext('t:DepartureDayShift',default='0',namespaces=NS))
        if not(0<=hh<24 and 0<=mm<60 and ss==0 and shift in {0,1}):raise ValueError('unsupported departure clock')
        calendar=effective_calendar(journey,calendar_patterns.get(journey.findtext('t:JourneyPatternRef',namespaces=NS)),service,
                                    bank_holiday_country='england-and-wales' if line in set(LINE_NAMES.values())|{'tram'} else None)
        weekdays=calendar['weekdays']
        converted=[station_for_stop(stop) for stop,activity in path if activity!='pass']
        rows.append({'lineID':line,'stationID':converted[0],'key':key((hh+24*shift)*60+mm,converted[1:]),
          'originActivity':path[0][1],**calendar,'start':start,'end':end,'member':member})
    return rows,{'member':member,'lineID':line,'sha256':raw_sha,
      'publishedAt':root.attrib.get('CreationDateTime'),'operatingStartDate':start,'operatingEndDate':end}

def read_archive(path: Path, tram_platforms=None) -> tuple[list[dict],list[dict]]:
    rows=[];members=[]
    with _nested_archive(path) as inner:
        for name in inner.namelist():
            if not name.endswith('.xml'):continue
            with inner.open(name) as source, _streamed_projection(source) as (root, raw_sha, journeys):
                try:parsed,meta=_origin_rows_from_projection(root,raw_sha,name,tram_platforms,journeys)
                except (ValueError,KeyError,TypeError) as error:
                    service=root.find('.//t:Service',NS)
                    line=published_line(service.findtext('t:Lines/t:Line/t:LineName',namespaces=NS),tram_platforms) if service is not None else None
                    if line is None:
                        del root, journeys
                        continue
                    start=service.findtext('t:OperatingPeriod/t:StartDate',namespaces=NS);end=service.findtext('t:OperatingPeriod/t:EndDate',namespaces=NS)
                    if not start or not end:raise ValueError('cannot scope invalid member '+name) from error
                    origins=set();nonboarding=True
                    for pattern in service.findall('t:StandardService/t:JourneyPattern',NS):
                        refs=(pattern.findtext('t:JourneyPatternSectionRefs',namespaces=NS) or '').split()
                        if not refs:raise ValueError('cannot scope invalid pattern '+name) from error
                        section=(root._section_by_id(refs[0]) if hasattr(root,'_section_by_id') else
                                 root.find(".//t:JourneyPatternSection[@id='"+refs[0]+"']",NS))
                        stop=section.findtext('t:JourneyPatternTimingLink/t:From/t:StopPointRef',namespaces=NS) if section is not None else None
                        activity=section.findtext('t:JourneyPatternTimingLink/t:From/t:Activity',namespaces=NS) if section is not None else None
                        nonboarding=nonboarding and activity in {'pass','setDown'}
                        origins.add(tram_platforms[stop] if line == 'tram' else txc_station(stop or ''))
                    parsed=[{'lineID':line,'stationID':origin,'start':start,'end':end,'member':name,'qualificationGap':str(error)} for origin in origins]
                    if nonboarding and str(error)=='non-passenger VehicleJourney origin activity':
                        for row in parsed:row['_discoveryNonPassengerOnly']=True
                    meta={'member':name,'lineID':line,'sha256':raw_sha,'operatingStartDate':start,'operatingEndDate':end,'qualificationGap':str(error)}
                rows.extend(parsed)
                if meta:members.append(meta)
            del root, journeys
    return rows,members

def active_service_date(row: dict, today: date, holidays: set[str]) -> date | None:
    """Return the first current/future published service date for one XML row."""
    try:
        start=max(today,date.fromisoformat(row['start']))
        end=date.fromisoformat(row['end'])
        weekdays=row['weekdays']
        if end < start or not weekdays or not set(weekdays) <= set(range(1,8)):
            return None
    except (KeyError,TypeError,ValueError):
        return None
    # Search each weekly residue, then choose the earliest actual date.
    # Closures are runtime evidence and must not erase published source facts.
    candidates=[]
    for weekday in sorted(weekdays):
        offset=(weekday-(start.isoweekday()%7+1))%7
        candidate=start+timedelta(days=offset)
        while candidate <= end and (candidate.isoformat() in holidays or not row_operates_on(row,candidate.isoformat())
                                   or row_calendar_gap(row,candidate.isoformat())):
            candidate+=timedelta(days=7)
        if candidate <= end:
            candidates.append(candidate)
    return min(candidates) if candidates else None

def passenger_origin_inventory(source_rows: list[dict], members: list[dict], membership: set[tuple[str,str]],
                               civil: str, holidays: set[str],
                               expected_xml_lines: set[str] | None = None) -> dict:
    """Report explicit, active XML passenger starts without changing entry qualification.

    `source_rows` comes from the same bounded official-archive parse as the
    timetable qualifier. An origin is admitted only when that parser observed
    a VehicleJourney whose first stop explicitly permits pickup, and the
    line/station pair exists in the current app catalogue. Through calls,
    depot movements, closures and route-sequence endpoints are not inferred.
    """
    today=date.fromisoformat(civil)
    aggregates={}
    malformed=[]
    for row in source_rows:
        active=active_service_date(row,today,holidays)
        if active is None:
            # Expired or out-of-horizon rows do not advertise a live candidate.
            # Malformed current rows are retained as an inventory limitation.
            try:
                dates=date.fromisoformat(row['start']),date.fromisoformat(row['end'])
                current=dates[1] >= today
                has_clock=bool(row.get('weekdays'))
            except (KeyError,TypeError,ValueError):
                current,has_clock=True,False
            if current and not has_clock:
                malformed.append({'member':row.get('member','unknown'),'lineID':row.get('lineID','unknown'),
                                  'reason':'missing or invalid operating weekdays'})
            continue
        pair=(row['lineID'],row['stationID'])
        if row.get('originActivity') not in {'pickUp','pickUpAndSetDown'}:
            malformed.append({'member':row.get('member','unknown'),'lineID':pair[0],
                               'stationID':pair[1],'reason':'origin lacks explicit passenger pickup'})
            continue
        item=aggregates.setdefault(pair,{'lineID':pair[0],'stationID':pair[1],'journeyRows':0,
            'firstActiveServiceDate':active,'serviceWindows':set()})
        item['journeyRows']+=1
        item['serviceWindows'].update(row_service_windows(row))
        if active < item['firstActiveServiceDate']:
            item['firstActiveServiceDate']=active

    origins=[];all_origins=[];uncatalogued=defaultdict(list)
    for pair,item in sorted(aggregates.items()):
        item['firstActiveServiceDate']=item['firstActiveServiceDate'].isoformat()
        item['serviceWindows']=[{'startDate':start,'endDate':end,'weekdays':list(weekdays)}
            for start,end,weekdays in sorted(item['serviceWindows'])]
        item['catalogued']=pair in membership
        all_origins.append(item)
        if item['catalogued']:
            origins.append(item)
        else:
            uncatalogued[pair[0]].append(pair[1])

    unresolved=[]
    for member in members:
        if member.get('qualificationGap'):
            try:
                active=date.fromisoformat(member['operatingEndDate']) >= today
            except (KeyError,TypeError,ValueError):
                active=True
            if active:
                unresolved.append({'member':member['member'],'lineID':member['lineID'],
                    'classification':'explicit-nonboarding-origin' if 'non-passenger VehicleJourney origin activity' in member['qualificationGap'] else 'unresolved-xml-qualification',
                    'reason':member['qualificationGap'][:180]})
    malformed=sorted({(item['member'],item['lineID'],item.get('stationID'),item['reason']):item for item in malformed}.values(),
                     key=lambda item:(item['lineID'],item['member'],item.get('stationID','')))
    unresolved=sorted(unresolved,key=lambda item:(item['lineID'],item['member']))
    uncatalogued={line:stations for line,stations in sorted(uncatalogued.items())}
    xml_lines=sorted({member['lineID'] for member in members})
    missing_lines=sorted((expected_xml_lines or set())-set(xml_lines))
    complete=not malformed and not unresolved and not missing_lines
    all_ends=[item['operatingEndDate'] for item in members if item.get('operatingEndDate')]
    return {'schemaVersion':1,'discoveryStatus':'complete' if complete else 'incomplete',
        'source':'same official TXC archive parse as qualification',
        'originSemantics':'Explicit pickup starts only; through/depot not inferred; route origin/closure not asserted. Tram and rail are separate adapters.',
        'horizon':{'startDate':civil,'endDate':max(all_ends) if all_ends else civil},
        'xmlMemberCount':len(members),'xmlLineIDs':xml_lines,'missingXmlLineIDs':missing_lines,
        'passengerOriginCount':len(origins),'activePassengerOrigins':all_origins,
        'bankHolidayDates':sorted(holidays),
        'uncataloguedOriginCount':sum(len(stations) for stations in uncatalogued.values()),
        'uncataloguedOrigins':uncatalogued,'unresolvedMembers':unresolved,'malformedCurrentRows':malformed}

def runtime_origin_scopes(source_rows, members, membership, assessed_at, holidays, *, expected_xml_lines=None):
    """Current discovery only; never departure authority or a substitute qualifier."""
    if not isinstance(assessed_at, datetime) or assessed_at.utcoffset() is None:
        raise ValueError('Discovery assessment must have an aware current instant')
    local=assessed_at.astimezone(ZoneInfo('Europe/London'));today=local.date();previous=today-timedelta(days=1)
    midnight=datetime.combine(today+timedelta(days=1),datetime.min.time(),ZoneInfo('Europe/London'))
    gaps=set();eligible=set();current=set();carry={};uncatalogued=set()
    def gap(code,line=None,station=None,impact=True):
        line=line if isinstance(line,str) and 0<len(line)<=64 else None
        station=station if isinstance(station,str) and 0<len(station)<=128 else None
        gaps.add((code,line,station,impact))
    def impact(row):
        try:return date.fromisoformat(row['start'])<=today and date.fromisoformat(row['end'])>=previous
        except (KeyError,TypeError,ValueError):return True
    def instant(day,raw):
        clock,path=raw.split('|',1)
        if not re.fullmatch(r'[0-9]{4}',clock) or not path or not 0<=int(clock)<2880:raise ValueError('Invalid raw departure')
        naive=datetime.combine(day,datetime.min.time())+timedelta(minutes=int(clock));values=set()
        for fold in (0,1):
            value=naive.replace(tzinfo=ZoneInfo('Europe/London'),fold=fold).astimezone(timezone.utc)
            if value.astimezone(ZoneInfo('Europe/London')).replace(tzinfo=None)==naive:values.add(value)
        if len(values)!=1:raise ValueError('Ambiguous or nonexistent raw London departure')
        return values.pop()
    member_gaps={item['member']:item for item in members if item.get('qualificationGap')}
    for item in member_gaps.values():
        scoped=[r for r in source_rows if r.get('member')==item['member']]
        if scoped and all(r.get('_discoveryNonPassengerOnly') is True for r in scoped):continue
        gap('unqualified-xml-member',item.get('lineID'),None,
            impact({'start':item.get('operatingStartDate'),'end':item.get('operatingEndDate')}))
    for row in source_rows:
        line,station=row.get('lineID'),row.get('stationID');pair=(line,station)
        if row.get('member') in member_gaps:continue
        try:
            if line in RAIL or line=='tram':continue
            if row.get('originActivity') not in {'pickUp','pickUpAndSetDown'}:
                # Explicit non-passenger starts never become passenger demand.
                if row.get('originActivity') in {'pass','setDown'}:continue
                raise ValueError('Missing passenger pickup evidence')
            if not isinstance(line,str) or not isinstance(station,str):raise ValueError('Missing XML origin identity')
            if (not isinstance(row.get('weekdays'),(list,set,tuple)) or not row['weekdays']
                    or any(type(day) is not int or not 1<=day<=7 for day in row['weekdays'])
                    or not 0<=(date.fromisoformat(row['end'])-date.fromisoformat(row['start'])).days<=730):
                raise ValueError('Invalid bounded operating calendar')
            active=active_service_date(row,today,holidays)
            if row.get('unsupportedNamedCalendarDates'):
                gap('unqualified-xml-row',line,station,False)
            operating=today.isoformat() not in holidays and row_operates_on(row,today.isoformat())
            if row_calendar_gap(row,today.isoformat()):raise ValueError('Unqualified current calendar')
            previous_operating=previous.isoformat() not in holidays and row_operates_on(row,previous.isoformat())
            previous_gap=row_calendar_gap(row,previous.isoformat())
            clock,path=row['key'].split('|',1)
            if not re.fullmatch(r'[0-9]{4}',clock) or not path or not 0<=int(clock)<2880:raise ValueError('Invalid raw departure')
            relevant=False
            # Only 24+ hour journeys from a potentially operating previous day
            # can contribute today. Unrelated DST clocks do not erase origins.
            if int(clock)>=1440 and (previous_operating or previous_gap):
                departure=instant(previous,row['key'])
                contributing=assessed_at<=departure<midnight
                if contributing and previous_gap:raise ValueError('Unqualified previous calendar')
                relevant=previous_operating and contributing
            if active is None and not relevant:continue
            if pair not in membership:
                uncatalogued.add(pair);gap('uncatalogued-passenger-origin',line,station,operating or relevant);continue
            scope=line+'/'+station;eligible.add(scope)
            if operating:current.add(scope)
            if relevant:carry[scope]=max(carry.get(scope,departure),departure)
        except (ValueError,KeyError,TypeError):gap('unqualified-xml-row',line,station,impact(row))
    for line in sorted((expected_xml_lines if expected_xml_lines is not None else set(LINE_NAMES.values())|{'dlr'})-{m['lineID'] for m in members}):
        gap('missing-xml-line',line)
    required=current|set(carry)
    transitions=[last+timedelta(milliseconds=1) for scope,last in carry.items() if scope not in current]
    until=min([midnight,*transitions])
    required_complete=len(required)<=256
    if not required_complete:gap('required-scope-overflow')
    effects={}
    for code,line,station,effect in gaps:effects[(code,line,station)]=effects.get((code,line,station),False) or effect
    public=[{'code':code,'lineID':line,'stationID':station,'affectsCurrentCoverage':effect}
            for (code,line,station),effect in sorted(effects.items(),key=lambda item:(item[0][0],item[0][1] or '',item[0][2] or ''))]
    return {'eligibleScopesComplete':True,'requiredScopesComplete':required_complete,
        'eligibleScopes':sorted(eligible),'requiredScopes':sorted(required) if required_complete else [],
        'unresolvedPublicSourceGaps':public,'validUntil':until.astimezone(timezone.utc).isoformat(),
        'discoveryStatus':'incomplete' if any(g['affectsCurrentCoverage'] for g in public) else 'complete',
        'counts':{'eligible':len(eligible),'required':len(required),'uncatalogued':len(uncatalogued)}}


def inventory_difference_digest(sidecar: dict) -> str:
    """Stable gap identity excludes capture time/horizon, preventing repeat alerts."""
    detail=sidecar['inventory']
    if sidecar.get('inventoryTruncated') is True:
        difference={'publicationSHA256':sidecar['publicationSHA256'],
            'xmlPublicationMembers':[[member['member'],member['lineID'],member['sha256']]
                for member in sidecar['xmlPublicationMembers']],
            'inventoryUnavailableReason':detail.get('inventoryUnavailableReason'),
            'passengerOriginCount':detail['passengerOriginCount'],
            'discoveryStatus':detail['discoveryStatus'],
            'uncataloguedOriginCount':detail['uncataloguedOriginCount']}
        return hashlib.sha256(json.dumps(difference,sort_keys=True,separators=(',',':')).encode('utf-8')).hexdigest()
    active_projection=[{'lineID':origin['lineID'],'stationID':origin['stationID'],
        'catalogued':origin['catalogued'],'serviceWindows':origin['serviceWindows']}
        for origin in detail['activePassengerOrigins']]
    difference={'publicationSHA256':sidecar['publicationSHA256'],
        'xmlPublicationMembers':[[member['member'],member['lineID'],member['sha256']]
            for member in sidecar['xmlPublicationMembers']],
        **{key:detail[key] for key in ('discoveryStatus','bankHolidayDates','missingXmlLineIDs',
            'unresolvedMembers','malformedCurrentRows')}}
    difference['activePassengerOrigins']=active_projection
    return hashlib.sha256(json.dumps(difference,sort_keys=True,separators=(',',':')).encode('utf-8')).hexdigest()

def compact_inventory_failure(sidecar: dict, reason: str) -> dict:
    detail=sidecar['inventory']
    sidecar['inventoryTruncated']=True
    sidecar['inventory']={key:detail[key] for key in (
        'schemaVersion','source','originSemantics','horizon','xmlMemberCount','xmlLineIDs','missingXmlLineIDs',
        'passengerOriginCount','uncataloguedOriginCount','bankHolidayDates')}
    sidecar['inventory'].update(discoveryStatus='incomplete',
        activePassengerOrigins=[],uncataloguedOrigins={},unresolvedMembers=[],malformedCurrentRows=[],
        inventoryUnavailableReason=reason[:180])
    sidecar['inventory']['inventoryDifferenceSHA256']=inventory_difference_digest(sidecar)
    return sidecar

def origin_inventory_sidecar(publication_sha: str, captured: str, catalogue: Path,
                             members: list[dict], inventory: dict) -> dict:
    roster_path=Path(__file__).with_name('tb085_renewal_roster.json')
    sidecar={'schemaVersion':1,'kind':'tubeboard-official-passenger-origin-inventory',
        'publicationSHA256':publication_sha,'capturedAt':captured,
        'producerSHA256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'rosterSHA256':hashlib.sha256(roster_path.read_bytes()).hexdigest(),
        'catalogueSHA256':hashlib.sha256(catalogue.read_bytes()).hexdigest(),
        'xmlPublicationMembers':members,'inventory':inventory}
    inventory['inventoryDifferenceSHA256']=inventory_difference_digest(sidecar)
    encoded=(json.dumps(sidecar,indent=2)+'\n').encode('utf-8')
    if len(encoded)>MAX_ORIGIN_INVENTORY_BYTES:
        sidecar=compact_inventory_failure(sidecar,'Full grouped origin inventory exceeds the 2 MiB evidence bound.')
    return sidecar

def inventory_from_archive(archive: Path, catalogue: Path, captured: str,
                           holiday_dates: list[str]) -> dict:
    """Generate the independent source inventory without fetching any station API."""
    publication_sha=_file_sha256(archive)
    civil=datetime.fromisoformat(captured).astimezone(ZoneInfo('Europe/London')).date().isoformat()
    source,members=read_archive(archive)
    catalogue_data=json.loads(catalogue.read_text())
    membership={(line['lineID'],station['stationID']) for station in catalogue_data['stations']
                for line in station['lines']}
    inventory_error=None
    try:
        inventory=passenger_origin_inventory(source,members,membership,civil,set(holiday_dates),
            set(LINE_NAMES.values())|{'dlr'})
    except Exception as error:
        inventory_error=f"Origin inventory could not be generated: {type(error).__name__}."
        inventory={'schemaVersion':1,'discoveryStatus':'incomplete',
            'source':'same official TXC archive parse as qualification',
            'originSemantics':'Explicit pickup starts only; through/depot not inferred; route origin/closure not asserted. Tram and rail are separate adapters.',
            'horizon':{'startDate':civil,'endDate':civil},'xmlMemberCount':len(members),
            'xmlLineIDs':sorted({member.get('lineID','unknown') for member in members}),
            'missingXmlLineIDs':[],'passengerOriginCount':0,'activePassengerOrigins':[],
            'bankHolidayDates':sorted(holiday_dates),'uncataloguedOriginCount':0,'uncataloguedOrigins':{},
            'unresolvedMembers':[],'malformedCurrentRows':[]}
    sidecar=origin_inventory_sidecar(publication_sha,captured,catalogue,members,inventory)
    if inventory_error:
        sidecar=compact_inventory_failure(sidecar,inventory_error)
    return sidecar

def unavailable_origin_inventory(publication_sha: str, captured: str, catalogue: Path,
                                 reason: str) -> dict:
    """Retain a fail-closed inventory result when a required source cannot be read."""
    inventory={'schemaVersion':1,'discoveryStatus':'incomplete',
        'source':'same official TXC archive parse as qualification',
        'originSemantics':'Explicit pickup starts only; through/depot not inferred; route origin/closure not asserted. Tram and rail are separate adapters.',
        'horizon':{'startDate':captured[:10],'endDate':captured[:10]},'xmlMemberCount':0,
        'xmlLineIDs':[],'missingXmlLineIDs':[],'passengerOriginCount':0,
        'activePassengerOrigins':[],'bankHolidayDates':[],'uncataloguedOriginCount':0,
        'uncataloguedOrigins':{},'unresolvedMembers':[],'malformedCurrentRows':[]}
    sidecar=origin_inventory_sidecar(publication_sha,captured,catalogue,[],inventory)
    return compact_inventory_failure(sidecar,reason)

def duration_seconds(value: str | None) -> int:
    """Bounded TXC duration; no calendar units, negatives or truncation."""
    match = re.fullmatch(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', value or '')
    if not match or not any(match.groups()):raise ValueError('unsupported timing duration')
    seconds = sum(int(part or 0)*factor for part,factor in zip(match.groups(),[3600,60,1]))
    if seconds > 172800:raise ValueError('unsupported timing duration')
    return seconds

def xml_selected_call_rows(data: bytes, member: str, station: str, direction: str, tram_platforms=None) -> tuple[list[dict],dict]:
    """TXC2.4 §3.7.2: departure = arrival + inbound-To/outbound-From waits.

    This separate opt-in path never changes the existing origin extractor.
    Full seconds accumulate; §3.7.2.2 floors the resulting display minute once.
    Only explicitly supported timing/calendar constructs can produce evidence.
    """
    if direction not in {'inbound','outbound'}:raise ValueError('unsupported selected direction')
    with _streamed_projection(io.BytesIO(data), selected=True) as (root, raw_sha, journeys):
        return _selected_rows_from_projection(root, raw_sha, member, station, direction, tram_platforms, journeys)


def _selected_rows_from_projection(root, raw_sha, member, station, direction, tram_platforms, journeys):
    services=root.findall('.//t:Service',NS)
    if len(services)!=1:raise ValueError('unexpected service count')
    service=services[0];names=[e.text for e in service.findall('t:Lines/t:Line/t:LineName',NS)]
    line = published_line(names[0], tram_platforms) if len(names) == 1 else None
    if line is None:return [],{}
    station_for_stop = tram_platforms.__getitem__ if line == 'tram' else txc_station
    start=service.findtext('t:OperatingPeriod/t:StartDate',namespaces=NS);end=service.findtext('t:OperatingPeriod/t:EndDate',namespaces=NS)
    if not start or not end or date.fromisoformat(start)>date.fromisoformat(end):raise ValueError('invalid operating period')
    sections={}
    stored_sections = getattr(root, '_record_store', None)
    for section in (root._sections() if hasattr(root, '_sections') else root.findall('.//t:JourneyPatternSection',NS)):
        ident=section.attrib.get('id');links=section.findall('t:JourneyPatternTimingLink',NS)
        if not ident or not links or ident in sections:raise ValueError('invalid section identity')
        if stored_sections is None:
            sections[ident]=links
        else:
            payload=_record_bytes(section)
            stored_sections.seek(0,2);offset=stored_sections.tell();_write_spool(stored_sections, payload)
            sections[ident]=(offset,len(payload))
    def section_links(ref):
        if stored_sections is None:return sections[ref]
        offset,length=sections[ref];stored_sections.seek(offset)
        return ET.fromstring(stored_sections.read(length)).findall('t:JourneyPatternTimingLink',NS)
    patterns={}
    for pattern in service.findall('t:StandardService/t:JourneyPattern',NS):
        ident=pattern.attrib.get('id');refs=(pattern.findtext('t:JourneyPatternSectionRefs',namespaces=NS) or '').split()
        if not ident or ident in patterns or not refs or any(ref not in sections for ref in refs):raise ValueError('invalid pattern reference')
        links=[link for ref in refs for link in section_links(ref)]
        # Reuse explicit activity/boundary validation, without dropping pass timing.
        uses=[]
        for link in links:
            if any(local_tag(c) not in {'From','To','RouteLinkRef','RunTime','Direction'} for c in link):raise ValueError('unsupported timing construct')
            pair=[]
            for end_name in ['From','To']:
                usage=link.find('t:'+end_name,NS)
                if usage is None or any(local_tag(c) not in {'StopPointRef','Activity','TimingStatus','WaitTime','DynamicDestinationDisplay','Vias'} for c in usage):raise ValueError('unsupported stop usage')
                stop=usage.findtext('t:StopPointRef',namespaces=NS);activity=usage.findtext('t:Activity',namespaces=NS)
                if not stop or activity not in {'pickUp','pickUpAndSetDown','setDown','pass'}:raise ValueError('unknown/missing calling activity')
                wait=usage.findtext('t:WaitTime',namespaces=NS)
                pair.append((stop,activity,0 if wait is None else duration_seconds(wait)))
            if uses and uses[-1][:2]!=pair[0][:2]:raise ValueError('disconnected or contradictory timing boundary')
            if not uses:uses.append(pair[0])
            uses.append(pair[1])
        raw_direction=pattern.findtext('t:Direction',namespaces=NS)
        occurrences=[i for i,use in enumerate(uses[:-1]) if station_for_stop(use[0])==station and use[1] in {'pickUp','pickUpAndSetDown'}]
        if occurrences and raw_direction not in {'inbound','outbound'}:raise ValueError('unknown publisher direction')
        # All patterns above are validated. Only matching patterns' complete
        # timing links are consumed by the later selected-journey validator.
        retained = bool(occurrences) and raw_direction == direction
        patterns[ident]=(pattern,links if retained else [],uses if retained else [],raw_direction,occurrences)
    rows=[]
    for journey in journeys:
        ref=journey.findtext('t:JourneyPatternRef',namespaces=NS)
        if ref not in patterns:raise ValueError('missing pattern reference')
        pattern,links,uses,raw_direction,occurrences=patterns[ref]
        if not occurrences or raw_direction!=direction:continue
        if any(link.findtext('t:Direction',namespaces=NS) not in {None,'inherit',raw_direction} for link in links):raise ValueError('contradictory link direction')
        service_ref=journey.findtext('t:ServiceRef',namespaces=NS)
        service_code=service.findtext('t:ServiceCode',namespaces=NS)
        if service_ref is not None and service_ref!=service_code:raise ValueError('wrong journey service reference')
        line_ref=journey.findtext('t:LineRef',namespaces=NS) or pattern.findtext('t:LineRef',namespaces=NS)
        line_ids={value.attrib.get('id') for value in service.findall('t:Lines/t:Line',NS)}
        if line_ref is not None and line_ref not in line_ids:raise ValueError('wrong journey line reference')
        validate_display_only_overrides(journey,links)
        if any(journey.find('t:'+tag,NS) is not None for tag in ['VehicleJourneyRef','StartDeadRun','EndDeadRun','Frequency']):raise ValueError('unsupported journey timing override')
        if any(pattern.find('t:'+tag,NS) is not None for tag in ['StartDeadRun','EndDeadRun','Frequency']):raise ValueError('unsupported pattern timing construct')
        if uses[0][1] not in {'pickUp','pickUpAndSetDown'} or uses[-1][1] not in {'setDown','pickUpAndSetDown'}:raise ValueError('nonboarding origin or nonalighting destination')
        if uses[0][2]!=0:raise ValueError('unsupported initial wait')
        clock=journey.findtext('t:DepartureTime',namespaces=NS)
        if not clock or not re.fullmatch(r'\d{2}:\d{2}:\d{2}',clock):raise ValueError('unsupported departure clock')
        hh,mm,ss=map(int,clock.split(':'));shift=int(journey.findtext('t:DepartureDayShift',default='0',namespaces=NS))
        if not(0<=hh<24 and 0<=mm<60 and 0<=ss<60 and shift in {0,1}):raise ValueError('unsupported departure clock')
        calendar=effective_calendar(journey,pattern,service,
                                    bank_holiday_country='england-and-wales' if line in set(LINE_NAMES.values())|{'tram'} else None)
        weekdays=calendar['weekdays']
        seconds=(hh+24*shift)*3600+mm*60+ss
        departures=[seconds]
        for index,link in enumerate(links):
            seconds+=duration_seconds(link.findtext('t:RunTime',namespaces=NS))
            # Arrival-To and departure-From are independent wait contributions.
            seconds+=uses[index+1][2]
            if index+1<len(links):
                wait=links[index+1].findtext('t:From/t:WaitTime',namespaces=NS)
                seconds+=0 if wait is None else duration_seconds(wait)
            departures.append(seconds)
        for occurrence in occurrences:
            onward=[station_for_stop(stop) for stop,activity,_ in uses[occurrence+1:] if activity!='pass']
            # A real nonadjacent round trip retains its complete ordered path.
            # Immediate/adjacent same-station calls offer no distinct onward call.
            if not onward or not any(stop!=station for stop in onward):raise ValueError('unqualified selected onward destination')
            rows.append({'lineID':line,'stationID':station,'direction':direction,'key':key(departures[occurrence]//60,onward),
                **calendar,'start':start,'end':end,'member':member})
    return rows,{'member':member,'lineID':line,'sha256':raw_sha,'operatingStartDate':start,'operatingEndDate':end}

def read_selected_archive(path: Path, requests: list[tuple[str,str,str]], members: list[dict], tram_platforms=None) -> list[dict]:
    """Only members already identified by the existing generator for selected lines."""
    rows=[]
    with _nested_archive(path) as inner:
        for line,station,direction in requests:
            for meta in members:
                if meta['lineID']!=line:continue
                try:
                    with inner.open(meta['member']) as source, _streamed_projection(source, selected=True) as (root, raw_sha, journeys):
                        parsed,_=_selected_rows_from_projection(root,raw_sha,meta['member'],station,direction,tram_platforms,journeys)
                    rows.extend(parsed)
                except (ValueError,KeyError,TypeError) as error:
                    rows.append({'lineID':line,'stationID':station,'direction':direction,'member':meta['member'],
                        'start':meta['operatingStartDate'],'end':meta['operatingEndDate'],'qualificationGap':str(error)})
                finally:
                    # Release caller references even when member validation fails.
                    root = journeys = None
    return rows

def qualify_directional_entry(record: dict, selected_rows: list[dict], capture_dir: Path, civil: str, holidays: set[str]) -> dict:
    scopes=record.get('directionalTimetableSources')
    gap={'lineID':record['lineID'],'stationID':record['stationID'],'status':'gap','gapReason':'invalid directional source definitions','nonOperationBankHolidays':True,'profiles':[]}
    if not isinstance(scopes,list) or not 1<=len(scopes)<=2:return gap
    directions=[scope.get('direction') for scope in scopes]
    if len(set(directions))!=len(directions) or any(d not in {'inbound','outbound'} for d in directions):return gap
    definitions=[];evidence=[]
    for scope in sorted(scopes,key=lambda s:s['direction']):
        direction=scope['direction'];source=scope.get('timetableSource',{})
        try:
            body=(capture_dir/source['body']).read_bytes()
            if not re.fullmatch(r'[0-9a-f]{64}',source.get('sha256','')) or hashlib.sha256(body).hexdigest()!=source['sha256']:raise ValueError('directional source body differs')
            payload=json.loads(body)
            if payload.get('direction')!=direction:raise ValueError('wrong API direction')
            rows=[r for r in selected_rows if r['lineID']==record['lineID'] and r['stationID']==record['stationID'] and r.get('direction')==direction]
            scoped=dict(record,timetableSource=source)
            result=qualify_entry(scoped,rows,capture_dir,civil,holidays, allow_partial_week=False)
            if result['status']!='qualified':raise ValueError(result['gapReason'])
            definitions.append({'direction':direction,'profiles':result['profiles']})
            evidence.append({'direction':direction,'apiBodySHA256':result['apiBodySHA256'],'operatingStartDate':result['operatingStartDate'],
                'operatingEndDate':result['operatingEndDate'],'xmlMembers':result['xmlMembers'],'originatingDateGaps':result['originatingDateGaps']})
        except (ValueError,KeyError,TypeError,OSError) as error:
            gap['gapReason']='direction '+direction+': '+str(error);return gap
    # Overlapping raw keys in opposite direction scopes lack a disjoint service proof.
    keys=[]
    for scope in scopes:
        payload=json.loads((capture_dir/scope['timetableSource']['body']).read_bytes())
        keys.append(set(k for values in api_profile_rows(payload,record['lineID'],record['stationID']).values() for k in values))
    if len(keys)==2 and keys[0]&keys[1]:gap['gapReason']='overlapping directional service keys';return gap
    return dict(gap,status='qualified',gapReason=None,directionalDefinitions=definitions,
        operatingStartDate=min(e['operatingStartDate'] for e in evidence),operatingEndDate=max(e['operatingEndDate'] for e in evidence),
        directionalSourceEvidence=evidence)


def api_profile_rows(payload: dict,line: str,station: str) -> dict[str,list[str]]:
    if payload.get('lineId')!=line or payload.get('timetable',{}).get('departureStopId')!=station:raise ValueError('wrong line or station')
    profiles=defaultdict(list)
    for route in payload['timetable']['routes']:
        paths={}
        for interval in route.get('stationIntervals',[]):
            ident=str(interval['id'])
            if ident in paths:raise ValueError('duplicate interval identity')
            paths[ident]=[s['stopId'] for s in interval['intervals']]
        for schedule in route.get('schedules',[]):
            name=schedule['name']
            if name not in API_DAYS:raise ValueError('unqualified API profile '+name)
            for journey in schedule.get('knownJourneys',[]):
                hh,mm=int(journey['hour']),int(journey['minute'])
                if not(0<=hh<48 and 0<=mm<60):raise ValueError('invalid API minute')
                profiles[name].append(key(hh*60+mm,paths[str(journey['intervalId'])]))
    if not profiles:raise ValueError('no known journey schedules')
    return dict(profiles)

def agreed_definition(rows: list[dict], civil: str, *, normalized_keys: dict[str,str] | None=None) -> tuple[Counter | None,str | None]:
    weekday=date.fromisoformat(civil).isoweekday()%7+1
    applicable=[r for r in rows if r['start']<=civil<=r['end']]
    if any(r.get('qualificationGap') for r in applicable):return None,'unsupported publisher member'
    if any(row_calendar_gap(r,civil) for r in applicable):return None,'unsupported named calendar date'
    definitions=defaultdict(Counter)
    for row in applicable:
        definitions[row['member']]  # Retain explicit empty definitions for conflict checks.
        if row_operates_on(row,civil):
            raw=row['key']
            if normalized_keys is None:normalized=logical_key(raw)
            else:
                normalized=normalized_keys.get(raw)
                if normalized is None:
                    normalized=logical_key(raw);normalized_keys[raw]=normalized
            definitions[row['member']][normalized]+=1
    values=list(definitions.values())
    if not values:return None,'no published originating definition'
    if any(value!=values[0] for value in values[1:]):return None,'publication member conflict'
    return values[0],None

def date_ranges(dates: list[str], eligible: set[str], weekdays: set[int]) -> list[dict]:
    ranges=[];begin=last=None
    for civil in dates:
        weekday=date.fromisoformat(civil).isoweekday()%7+1
        if weekday not in weekdays or civil in eligible:
            if begin is None:begin=civil
            last=civil
        elif begin is not None:
            ranges.append({'startDate':begin,'endDate':last});begin=last=None
    if begin is not None:ranges.append({'startDate':begin,'endDate':last})
    return [r for r in ranges if any(r['startDate']<=d<=r['endDate'] for d in eligible)]

def qualify_entry(record:dict,source_rows:list[dict],capture_dir:Path,civil_date:str,holidays:set[str] | None=None, *, allow_partial_week=True) -> dict:
    line,station=record['lineID'],record['stationID']
    entry={'lineID':line,'stationID':station,'status':'gap','gapReason':None,
      'nonOperationBankHolidays':True,'profiles':[]}
    if line in RAIL:
        entry['gapReason']='Rail uses qualified ArrivalDepartures scheduled/estimated departure fields; Unified origin timetable is not this adapter.';return entry
    rows=[r for r in source_rows if r['lineID']==line and r['stationID']==station]
    if not rows:entry['gapReason']='No published XML origin journeys; through/loop offsets are not inferred.';return entry
    try:
        start=min(r['start'] for r in rows);end=max(r['end'] for r in rows)
        d=date.fromisoformat(start);final=date.fromisoformat(end)
        if final<d or (final-d).days>730:raise ValueError('unsupported publication date span')
        dates=[]
        while d<=final:dates.append(d.isoformat());d+=timedelta(days=1)
        # Reuse long normalized paths only within this scoped qualification.
        # Date counters retain multiplicity but share their immutable key values.
        normalized_keys={}
        definitions={civil:agreed_definition(rows,civil,normalized_keys=normalized_keys) for civil in dates}
        meta=record['timetableSource']
        if meta.get('status')!=200:raise ValueError('timetable HTTP '+str(meta.get('status')))
        body=(capture_dir/meta['body']).read_bytes();profiles=api_profile_rows(json.loads(body),line,station)
        covered=set().union(*(API_DAYS[n] for n in profiles))
        if any(sum(day in API_DAYS[n] for n in profiles)>1 for day in range(1,8)):
            raise ValueError('overlapping API weekday profiles')
        # A missing weekday cannot supply a departure. Keep it explicit while
        # independently comparing the complete service on every offered day.
        gaps = [{'serviceDate': civil, 'reason': 'no matching API weekday profile'}
                for civil, (expected, _) in definitions.items()
                if expected and date.fromisoformat(civil).isoweekday() % 7 + 1 not in covered]
        for name,actual in profiles.items():
            weekdays=API_DAYS[name];maximum=Counter()
            for civil,(expected,error) in definitions.items():
                if expected is not None and date.fromisoformat(civil).isoweekday()%7+1 in weekdays:maximum |= expected
            raw=Counter(map(logical_key,actual))
            if raw-maximum:raise ValueError('XML/API full path parity differs for '+name+' unexplained API occurrence')
            variants={}
            for civil in dates:
                weekday=date.fromisoformat(civil).isoweekday()%7+1
                if weekday not in weekdays:continue
                expected,error=definitions[civil]
                if error or civil in (holidays or set()):
                    gaps.append({'serviceDate':civil,'reason':error or 'bank holiday withheld'});continue
                if expected-raw:
                    gaps.append({'serviceDate':civil,'reason':'missing published API occurrence'});continue
                excess=raw-expected;retained=[];excluded=Counter()
                for raw_key in sorted(actual):
                    logical=logical_key(raw_key)
                    if excess[logical]>0:excluded[raw_key]+=1;excess[logical]-=1
                    else:retained.append(raw_key)
                if Counter(map(logical_key,retained))!=expected:raise ValueError('missing complete published subset')
                identity=tuple(sorted(excluded.items()))
                if identity not in variants:
                    variant={'name':name,'weekdays':set(),**fingerprint(actual),'eligibleDates':set()}
                    if excluded:
                        digest=fingerprint(retained)
                        if actual and not retained:
                            if len(actual)>20000:raise ValueError('unsupported complete exclusion raw count')
                            # Complete exclusions retain exact raw authority,
                            # without repeating every excluded journey key.
                            variant.update(allExcluded=True,publishedCount=0,publishedSHA256=digest['sha256'])
                        else:
                            variant.update(excludedJourneyKeys=[{'key':k,'count':c} for k,c in sorted(excluded.items())],publishedCount=digest['count'],publishedSHA256=digest['sha256'])
                    variants[identity]=variant
                variants[identity]['weekdays'].add(weekday);variants[identity]['eligibleDates'].add(civil)
            for variant in variants.values():
                days=variant.pop('weekdays');eligible=variant.pop('eligibleDates');ranges=date_ranges(dates,eligible,days)
                if not ranges or len(ranges)>32:raise ValueError('unsupported originating date range count')
                variant.update(weekdays=sorted(days),originatingServiceDateRanges=ranges)
                entry['profiles'].append(variant)
        if not entry['profiles'] or len(entry['profiles'])>64:raise ValueError('unsupported originating profile count')
        if not allow_partial_week and set().union(*(set(p['weekdays']) for p in entry['profiles'])) != set(range(1, 8)):
            raise ValueError('directional timetable requires all seven weekdays')
        entry.update(status='qualified',gapReason=None,operatingStartDate=start,operatingEndDate=end,
          originatingDateGaps=sorted(gaps,key=lambda g:g['serviceDate']),xmlMembers=sorted({r['member'] for r in rows}),apiBodySHA256=hashlib.sha256(body).hexdigest())
    except (ValueError,KeyError,TypeError) as error:
        entry['gapReason']=str(error);entry['profiles']=[]
    return entry

def generate_with_inventory(archive:Path,capture_dir:Path,catalogue:Path,capture_overrides:Path | None=None, *,
                            qualification_date: date | None=None, _parsed_archive=None) -> tuple[dict,dict]:
    download=json.loads((capture_dir/'publication-download.json').read_text());sha=_file_sha256(archive)
    if download['sha256']!=sha:raise ValueError('archive differs from captured publication')
    headers={k.lower():v for k,v in download['headers'].items()}
    if headers.get('x-amz-meta-sha256')!=sha:raise ValueError('publisher/body identity mismatch')
    captured=download['receivedAt']
    # A cached ZIP keeps its acquisition clock; runtime inventory can use the
    # independently reobserved current civil day without retiming the source.
    if qualification_date is not None and type(qualification_date) is not date:
        raise ValueError('qualification_date must be an explicit civil date')
    civil=(qualification_date or datetime.fromisoformat(captured).astimezone(ZoneInfo('Europe/London')).date()).isoformat()
    holidays=json.loads((capture_dir/'bank-holidays.body').read_text())['england-and-wales']['events']
    holiday_dates=sorted({e['date'] for e in holidays})
    tram_capture = capture_dir / 'tram-stop-points.body'
    tram_platforms = None
    if tram_capture.is_file():
        from tb085_tram_stations import platform_parents, stations
        tram_platforms = platform_parents(json.loads(tram_capture.read_bytes()), stations())
    source,members=read_archive(archive,tram_platforms) if _parsed_archive is None else _parsed_archive
    records=json.loads((capture_dir/'line-station-matrix.json').read_text())
    extra=capture_dir/'extra-line-station-matrix.json'
    if extra.exists():records+=json.loads(extra.read_text())
    if capture_overrides is not None:
        overrides=json.loads(capture_overrides.read_text())
        if not isinstance(overrides,list) or len(overrides)>32:raise ValueError('invalid bounded capture overrides')
        replacements={(r['lineID'],r['stationID']):r for r in overrides}
        if len(replacements)!=len(overrides):raise ValueError('duplicate capture override')
        if not set(replacements).issubset({(r['lineID'],r['stationID']) for r in records}):raise ValueError('override outside captured scope')
        records=[replacements.get((r['lineID'],r['stationID']),r) for r in records]
    directional_requests=[]
    for record in records:
        if 'directionalTimetableSources' not in record:continue
        scopes=record['directionalTimetableSources']
        if not isinstance(scopes,list) or not 1<=len(scopes)<=2:raise ValueError('invalid directional source definitions')
        if record['lineID'] in RAIL:raise ValueError('rail calendar source not qualified by selected Tube adapter')
        directions=[scope.get('direction') for scope in scopes]
        if len(set(directions))!=len(directions) or any(d not in {'inbound','outbound'} for d in directions):raise ValueError('invalid directional source definitions')
        directional_requests.extend((record['lineID'],record['stationID'],direction) for direction in directions)
    directional_requests=sorted(set(directional_requests))
    if len(directional_requests)>64:raise ValueError('unbounded selected-call capture scope')
    catalogue_data=json.loads(catalogue.read_text())
    membership={(l['lineID'],s['stationID']) for s in catalogue_data['stations'] for l in s['lines']}
    if tram_platforms:
        membership.update(('tram', station) for station in tram_platforms.values())
    inventory_error=None
    try:
        origin_inventory=passenger_origin_inventory(source,members,membership,civil,set(holiday_dates),
            set(LINE_NAMES.values())|{'dlr'})
    except Exception as error:
        # Inventory discovery is diagnostic and must not gate the independent
        # rider proof once its qualification inputs have already been read.
        inventory_error=f"Origin inventory could not be generated: {type(error).__name__}."
        xml_lines=sorted({member.get('lineID','unknown') for member in members})
        origin_inventory={'schemaVersion':1,'discoveryStatus':'incomplete',
            'source':'same official TXC archive parse as qualification',
            'originSemantics':'Explicit pickup starts only; through/depot not inferred; route origin/closure not asserted. Tram and rail are separate adapters.',
            'horizon':{'startDate':civil,'endDate':civil},'xmlMemberCount':len(members),
            'xmlLineIDs':xml_lines,'missingXmlLineIDs':[],'passengerOriginCount':0,
            'activePassengerOrigins':[],'bankHolidayDates':sorted(holiday_dates),
            'uncataloguedOriginCount':0,
            'uncataloguedOrigins':{},'unresolvedMembers':[],'malformedCurrentRows':[]}
    entries=[];seen=set();directional_records=[]
    for record in records:
        pair=(record['lineID'],record['stationID'])
        if pair not in membership:raise ValueError('capture outside current catalogue '+str(pair))
        if pair in seen:continue
        seen.add(pair)
        if 'directionalTimetableSources' in record:directional_records.append(record)
        else:entries.append(qualify_entry(record,source,capture_dir,civil,set(holiday_dates)))
    # Qualified origin entries and inventory do not retain the large XML rows.
    # Release them before building selected-call trees and rows.
    source=None
    selected_rows=read_selected_archive(archive,directional_requests,members,tram_platforms) if directional_requests else []
    for record in directional_records:
        entries.append(qualify_directional_entry(record,selected_rows,capture_dir,civil,set(holiday_dates)))
    proof={'schemaVersion':1,'publication':{'url':SOURCE_URL,'sha256':sha,
      'publishedAt':headers.get('last-modified'),'capturedAt':captured},'timezone':'Europe/London',
      'bankHolidayDates':holiday_dates,'holidaySource':'https://www.gov.uk/bank-holidays.json',
      'holidayCoverageStart':min(holiday_dates),'holidayCoverageEnd':max(holiday_dates),
      'canonicalKey':'extendedMinute(4 ASCII digits)|ordered API interval stop IDs joined with >; sorted LF keys; preserve duplicates',
      'sourceParityEquivalence':'Compare each applicable publisher member complete counted calling multiset per originating date; overlapping members must agree, never sum or override. Omit only explicit pass activity; adjacent API timing intervals have logical station parity. Retain nonadjacent revisits/duplicate journeys. Per-profile agreed-date maximum accounts for raw keys; exact counted exclusions and bounded date ranges qualify complete originating subsets.',
      'qualificationScope':('Origin departures plus explicitly captured direction-scoped selected calling-stop departures. Every bank holiday is conservatively withheld. Runtime publication/parity/freshness/calendar/closure qualification remains required.' if directional_requests else 'Origin departures only. Every bank holiday is conservatively withheld. Runtime publication/parity/freshness/calendar/closure qualification remains required.'),
      'entries':sorted(entries,key=lambda e:(e['lineID'],e['stationID'])),'xmlPublications':members,
      'coverage':{'catalogueLineIDs':sorted({p[0] for p in membership}),'capturedLineIDs':sorted({e['lineID'] for e in entries}),
      'uncapturedStationLinePairs':len(membership-seen)}}
    sidecar=origin_inventory_sidecar(sha,captured,catalogue,members,origin_inventory)
    if inventory_error:
        sidecar=compact_inventory_failure(sidecar,inventory_error)
    return proof,sidecar

def generate(archive:Path,capture_dir:Path,catalogue:Path,capture_overrides:Path | None=None) -> dict:
    return generate_with_inventory(archive,capture_dir,catalogue,capture_overrides)[0]

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive',required=True,type=Path);parser.add_argument('--capture-dir',required=True,type=Path)
    parser.add_argument('--catalogue',type=Path,default=Path(__file__).resolve().parents[1]/'TubeBoard Watch App/TubeStationCatalog.json')
    parser.add_argument('--capture-overrides',type=Path)
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--inventory-output',type=Path,help='Write the standalone passenger-origin inventory sidecar')
    args=parser.parse_args()
    if args.inventory_output:
        result,inventory=generate_with_inventory(args.archive,args.capture_dir,args.catalogue,args.capture_overrides)
        args.inventory_output.write_text(json.dumps(inventory,indent=2)+'\n')
    else:
        result=generate(args.archive,args.capture_dir,args.catalogue,args.capture_overrides)
    args.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'qualified':sum(e['status']=='qualified' for e in result['entries']),'gaps':sum(e['status']=='gap' for e in result['entries']),'coverage':result['coverage']},indent=2))
if __name__=='__main__':main()
