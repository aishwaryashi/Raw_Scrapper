# Graph Report - Raw_Sulekha_Bug  (2026-07-07)

## Corpus Check
- 13 files · ~65,389 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1144 nodes · 1342 edges · 60 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `fef7ff30`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]

## God Nodes (most connected - your core abstractions)
1. `buildFirestoreDoc()` - 28 edges
2. `enums` - 20 edges
3. `buildFirestoreDoc()` - 18 edges
4. `deepGet()` - 15 edges
5. `extractDetailPage()` - 14 edges
6. `buildAdRecord()` - 12 edges
7. `coalesce()` - 12 edges
8. `handleDetail()` - 10 edges
9. `extractAdIdFromUrl()` - 8 edges
10. `safeJsonParse()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `extractStructuredDataSection()` --calls--> `safeJsonParse()`  [EXTRACTED]
  src/extract.js → src/helpers.js
- `extractDetailPage()` --calls--> `deepMerge()`  [EXTRACTED]
  src/extract.js → src/helpers.js
- `extractDetailPage()` --calls--> `normalizeMissing()`  [EXTRACTED]
  src/extract.js → src/helpers.js
- `handleDetail()` --calls--> `extractDetailPage()`  [EXTRACTED]
  src/routes.js → src/extract.js
- `extractNextData()` --calls--> `safeJsonParse()`  [EXTRACTED]
  src/extract.js → src/helpers.js

## Communities (60 total, 0 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.00
Nodes (500): 10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008 (+492 more)

### Community 1 - "Community 1"
Cohesion: 0.05
Nodes (81): buildAdRecord(), coalesce(), COUNTRY_MAP, deepGet(), __dirname, enrichLocationGeo(), extractAdId(), extractAllEmbeddedJson() (+73 more)

### Community 2 - "Community 2"
Cohesion: 0.08
Nodes (41): addOneYear(), AGE_RANGE_SLUGS, AMENITY_SYNONYMS, buildFirestoreDoc(), deriveIntent(), deriveStayType(), extractRentFromText(), fetchUsMetroAreaByLatLng() (+33 more)

### Community 3 - "Community 3"
Cohesion: 0.05
Nodes (38): type, $ref, $ref, items, type, $ref, $ref, $ref (+30 more)

### Community 4 - "Community 4"
Cohesion: 0.06
Nodes (31): apify, maxMemoryMbytes, minMemoryMbytes, dependencies, apify, cheerio, crawlee, @crawlee/playwright (+23 more)

### Community 5 - "Community 5"
Cohesion: 0.11
Nodes (29): addOneYear(), AGE_RANGE_OPTIONS, buildAmenitiesMap(), buildFirestoreDoc(), extractFromAmenityKeys(), extractRentFromText(), fetchUsMetroAreaByLatLng(), FIXED_USER (+21 more)

### Community 6 - "Community 6"
Cohesion: 0.07
Nodes (29): type, type, type, type, $ref, type, type, type (+21 more)

### Community 7 - "Community 7"
Cohesion: 0.10
Nodes (21): format, type, format, type, $ref, description, type, example (+13 more)

### Community 8 - "Community 8"
Cohesion: 0.10
Nodes (21): type, type, type, type, type, properties, display, formattedAddress (+13 more)

### Community 9 - "Community 9"
Cohesion: 0.10
Nodes (20): description, rules, allOf, $defs, description, examples, $id, dedup (+12 more)

### Community 10 - "Community 10"
Cohesion: 0.11
Nodes (19): type, type, type, type, type, business, displayName, email (+11 more)

### Community 11 - "Community 11"
Cohesion: 0.12
Nodes (17): type, type, type, type, baths, beds, buildingName, isShared (+9 more)

### Community 12 - "Community 12"
Cohesion: 0.12
Nodes (17): type, type, type, type, type, city, country, countryCode (+9 more)

### Community 13 - "Community 13"
Cohesion: 0.13
Nodes (15): description, type, default, type, type, type, type, amount (+7 more)

### Community 14 - "Community 14"
Cohesion: 0.14
Nodes (14): description, type, type, type, required, type, properties, adId (+6 more)

### Community 15 - "Community 15"
Cohesion: 0.15
Nodes (11): allZips, batch, checks, countyEntries, countyMap, countyToMsa, __dirname, OUT_PATH (+3 more)

### Community 16 - "Community 16"
Cohesion: 0.18
Nodes (11): properties, type, type, format, type, availability, daysAvailable, from (+3 more)

### Community 17 - "Community 17"
Cohesion: 0.22
Nodes (9): apifyProxyCountry, apifyProxyGroups, useApifyProxy, proxyConfig, default, description, editor, title (+1 more)

### Community 18 - "Community 18"
Cohesion: 0.22
Nodes (9): type, type, properties, type, date, endTime, openHouse, startTime (+1 more)

### Community 19 - "Community 19"
Cohesion: 0.22
Nodes (9): type, properties, $ref, description, furnishing, rent, title, type (+1 more)

### Community 20 - "Community 20"
Cohesion: 0.25
Nodes (7): actorSpecification, buildTag, environmentVariables, APIFY_DISABLE_OUTDATED_WARNING, input, name, version

### Community 21 - "Community 21"
Cohesion: 0.25
Nodes (8): properties, type, type, neighborhoods, primary, secondary, items, type

### Community 22 - "Community 22"
Cohesion: 0.29
Nodes (7): default, description, maximum, minimum, title, type, maxConcurrency

### Community 23 - "Community 23"
Cohesion: 0.29
Nodes (7): default, description, maximum, minimum, title, type, maxRequestRetries

### Community 24 - "Community 24"
Cohesion: 0.29
Nodes (7): requestTimeoutSecs, default, description, maximum, minimum, title, type

### Community 25 - "Community 25"
Cohesion: 0.29
Nodes (7): startUrls, default, description, editor, prefill, title, type

### Community 26 - "Community 26"
Cohesion: 0.33
Nodes (6): default, description, minimum, title, type, maxDelayMs

### Community 27 - "Community 27"
Cohesion: 0.33
Nodes (6): description, editor, isSecret, title, type, googleMapsApiKey

### Community 28 - "Community 28"
Cohesion: 0.33
Nodes (6): default, description, minimum, title, type, maxItems

### Community 29 - "Community 29"
Cohesion: 0.33
Nodes (6): default, description, minimum, title, type, maxPaginationPages

### Community 30 - "Community 30"
Cohesion: 0.33
Nodes (6): default, description, minimum, title, type, minDelayMs

### Community 31 - "Community 31"
Cohesion: 0.33
Nodes (6): enum, type, enums, adexpirystatus, propertyType, enum

### Community 32 - "Community 32"
Cohesion: 0.40
Nodes (4): properties, schemaVersion, title, type

### Community 33 - "Community 33"
Cohesion: 0.40
Nodes (5): default, description, title, type, extractLdJson

### Community 34 - "Community 34"
Cohesion: 0.40
Nodes (5): default, description, title, type, extractNextData

### Community 35 - "Community 35"
Cohesion: 0.40
Nodes (5): default, description, title, type, debugMode

### Community 36 - "Community 36"
Cohesion: 0.40
Nodes (5): description, editor, title, type, firebaseServiceAccount

### Community 37 - "Community 37"
Cohesion: 0.40
Nodes (5): default, description, title, type, interceptApiCalls

### Community 38 - "Community 38"
Cohesion: 0.40
Nodes (5): useProxy, default, description, title, type

### Community 39 - "Community 39"
Cohesion: 0.40
Nodes (5): format, type, items, type, photos

### Community 40 - "Community 40"
Cohesion: 0.50
Nodes (4): default, enum, type, mode

### Community 41 - "Community 41"
Cohesion: 0.50
Nodes (4): to, default, format, type

### Community 42 - "Community 42"
Cohesion: 0.50
Nodes (4): default, enum, type, ageRange

### Community 43 - "Community 43"
Cohesion: 0.50
Nodes (4): vegetarian, default, enum, type

### Community 44 - "Community 44"
Cohesion: 0.50
Nodes (4): occupation, default, enum, type

### Community 45 - "Community 45"
Cohesion: 0.50
Nodes (4): pets, default, enum, type

### Community 46 - "Community 46"
Cohesion: 0.50
Nodes (4): smoking, default, enum, type

### Community 47 - "Community 47"
Cohesion: 0.67
Nodes (3): enum, type, amenity

### Community 48 - "Community 48"
Cohesion: 0.67
Nodes (3): enum, type, category

### Community 49 - "Community 49"
Cohesion: 0.67
Nodes (3): furnishing, enum, type

### Community 50 - "Community 50"
Cohesion: 0.67
Nodes (3): genderPreference, enum, type

### Community 51 - "Community 51"
Cohesion: 0.67
Nodes (3): language, enum, type

### Community 52 - "Community 52"
Cohesion: 0.67
Nodes (3): status, enum, type

### Community 53 - "Community 53"
Cohesion: 0.67
Nodes (3): utility, enum, type

### Community 54 - "Community 54"
Cohesion: 0.67
Nodes (3): yesNo, enum, type

### Community 55 - "Community 55"
Cohesion: 0.67
Nodes (3): yesNoGender, enum, type

### Community 56 - "Community 56"
Cohesion: 0.67
Nodes (3): intent, enum, type

### Community 57 - "Community 57"
Cohesion: 0.67
Nodes (3): seekerGender, enum, type

### Community 58 - "Community 58"
Cohesion: 0.67
Nodes (3): seekerOccupation, enum, type

## Knowledge Gaps
- **840 isolated node(s):** `title`, `type`, `schemaVersion`, `title`, `type` (+835 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `properties` connect `Community 14` to `Community 3`, `Community 6`, `Community 39`, `Community 9`, `Community 10`, `Community 11`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **Why does `enums` connect `Community 31` to `Community 9`, `Community 42`, `Community 43`, `Community 44`, `Community 45`, `Community 46`, `Community 47`, `Community 48`, `Community 49`, `Community 50`, `Community 51`, `Community 52`, `Community 53`, `Community 54`, `Community 55`, `Community 56`, `Community 57`, `Community 58`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **Why does `properties` connect `Community 12` to `Community 7`, `Community 8`, `Community 11`, `Community 13`, `Community 14`, `Community 19`?**
  _High betweenness centrality (0.028) - this node is a cross-community bridge._
- **What connects `title`, `type`, `schemaVersion` to the rest of the system?**
  _840 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.003992015968063872 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.05318352059925094 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.08246225319396051 - nodes in this community are weakly interconnected._