import com.onthegomap.planetiler.FeatureCollector;
import com.onthegomap.planetiler.Planetiler;
import com.onthegomap.planetiler.Profile;
import com.onthegomap.planetiler.config.Arguments;
import com.onthegomap.planetiler.reader.SourceFeature;
import com.onthegomap.planetiler.reader.osm.OsmElement;
import com.onthegomap.planetiler.reader.osm.OsmSourceFeature;
import java.io.IOException;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.regex.Pattern;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.Envelope;
import org.locationtech.jts.geom.Geometry;
import org.locationtech.jts.geom.LineString;
import org.locationtech.jts.geom.Polygon;

/**
 * M6 prototype: the sim's own OSM vector tiles (PMTiles, z14 only) with the same selection and the
 * same raw OSM tags as the Overpass filter in src/world/overpass.ts (FULL_FILTER), so the client can
 * rebuild Overpass-shaped JSON from a tile and feed it to parseOverpass unchanged.
 *
 * Layers: `areas` (polygons, buildings included), `lines`, `points`. Aerodrome outlines and runway
 * centrelines are not in the tiles: they go whole and unquantised to `<output>.aerodromes.json`,
 * because a tile's pads are built from aerodromes up to AERODROME_REACH_DEG away and keyed by their
 * exact geometry (src/world/aerodrome.ts), which clipped tile copies would break.
 *
 * The map's settlements (place=city|town|village nodes) and aerodromes and heliports (at the centre of
 * their bounding box, as Overpass `out center` puts them) with their names go to `<output>.places.json`
 * as Overpass-shaped elements, which src/world/map-features.ts reads with parseMapFeatures.
 *
 * Run (Java 21+):
 *   java -Xmx8g -cp planetiler.jar tiles/SimProfile.java --osm=austria.osm.pbf --output=out/austria.pmtiles
 * (Planetiler reads one OSM extract per run: one archive per extract, or the planet.)
 */
public class SimProfile implements Profile {

  static final int Z = 14;
  /** buildings and points (entrances) reach this far past the tile edge (256 px a tile): a building across the border is whole in both tiles */
  static final int BUILDING_BUFFER_PX = 32;
  /**
   * lines and water reach this far past the tile edge: a bridge's lift over what it crosses runs
   * LIFT_REACH_M = 150 m along the roads (src/world/road-levels.ts), and both tiles of a border must
   * see the same roads and crossings (overpass.ts ROAD_REACH_M). 32 px of a z14 tile are 150 m or
   * more up to 60° of latitude
   */
  static final int REACH_BUFFER_PX = 32;
  /**
   * sports grounds (leisure=pitch | track | stadium, src/world/aerodrome.ts isPitchGround) reach a
   * whole tile past the edge: one smaller than a tile is then whole in every tile it touches, as
   * Overpass hands it over. Its pad, its floodlights and a stadium's stands are built from the whole
   * outline (aerodrome.ts, pitch-markings.ts, stadium-mesher.ts); a share cut at the tile edge would
   * put stands on the cut and a pad of its own in each tile
   */
  static final int GROUND_BUFFER_PX = 256;
  static final Pattern GROUND = Pattern.compile("^(pitch|track|stadium)$");

  /** overpass.ts ROAD_SELECTOR: the drawn roads and paths */
  static final Pattern HIGHWAY = Pattern.compile("^((motorway|trunk|primary|secondary|tertiary)(_link)?|residential|unclassified|road|living_street|service|track|pedestrian|busway|raceway|footway|path|cycleway|bridleway|steps)$");
  static final Pattern RAILWAY = Pattern.compile("^(rail|narrow_gauge|light_rail)$");
  static final Pattern AEROWAY = Pattern.compile("runway|taxiway|apron|helipad");
  static final Pattern NATURAL_WAY = Pattern.compile("water|wood|scrub|beach|bare_rock");
  static final Pattern WATERWAY = Pattern.compile("^(river|riverbank|canal|stream|brook|ditch|drain)$");
  static final Pattern LEISURE = Pattern.compile("park|pitch|golf_course|swimming_pool|track|stadium");
  static final Pattern MAST = Pattern.compile("^(mast|antenna)$");
  static final Pattern ORCHARD = Pattern.compile("^(orchard|vineyard)$");
  static final Pattern PIER = Pattern.compile("^(pier|breakwater|groyne)$");
  /** overpass.ts LAND_ZONES, and the open land's natural ones (way-styles landZone) */
  static final Pattern LAND_ZONE = Pattern.compile("^(residential|commercial|retail|industrial|cemetery|quarry|landfill|construction|brownfield|grass|meadow|village_green|recreation_ground)$");
  static final Pattern NATURAL_ZONE = Pattern.compile("^(grassland|heath)$");
  /** overpass.ts: the lifts aerialway-mesher draws, and their pylons and stations */
  static final Pattern LIFT = Pattern.compile("^(gondola|cable_car|chair_lift|mixed_lift)$");
  static final Pattern LIFT_NODE = Pattern.compile("^(pylon|station)$");
  static final Pattern SEA_LIGHT = Pattern.compile("^(lighthouse|beacon)$");
  /** overpass.ts: the walls wall-mesher stands */
  static final Pattern WALL = Pattern.compile("^(wall|retaining_wall|city_wall|fence)$");

  /**
   * tags the client reads (grep of src/world): the rest are dropped. Wall and roof materials and
   * colours (building:material, roof:material, building:colour, roof:colour...) and the architectural
   * style (building:architecture, arch-styles archProfile) come with KEY_PREFIXES.
   */
  static final Set<String> KEYS = Set.of(
    "building", "building:part", "height", "min_height", "location", "layer", "colour", "color",
    "highway", "railway", "waterway", "aeroway", "natural", "landuse", "leisure", "man_made", "tower:type", "tower:construction",
    "entrance", "width", "lanes", "lit", "surface", "oneway", "tunnel", "bridge", "ref", "local_ref",
    "leaf_type", "wood", "icao", "iata", "aerodrome", "aerodrome:type", "area", "name", "name:en",
    "service", "tracktype", "amenity", "parking", "junction", "sport", "shop", "healthcare", "trees", "ele", "religion", "power", "voltage", "indoor", "historic", "ruins", "aerialway", "tomb", "barrier", "material", "wall", "genus", "species", "taxon", "fence_type",
    // pedestrian crossings: their nodes and the crossing ways (ground-cover zebras)
    "crossing", "footway", "cycleway",
    // a place of worship's denomination: an Orthodox or a Western church (temples.ts faithOf)
    "denomination",
    // the year a building was built (building-mesher hasPanoramicWindows, arch-styles inferArchitecture;
    // amenity=place_of_worship there too)
    "start_date");
  /** the charted lights' keys (lighthouse-mesher.ts) */
  static final String[] SEAMARK_PREFIXES = {"seamark:light:", "seamark:beacon_cardinal:"};
  static final String[] KEY_PREFIXES = {"building:", "roof:"};

  static final String[] AREA_KEYS = {"natural", "landuse", "leisure", "aeroway", "waterway", "building"};

  /** what the map draws (map-features.ts): settlements by size, aerodromes and heliports */
  static final Pattern PLACE = Pattern.compile("^(city|town|village)$");
  static final Pattern MAP_AEROWAY = Pattern.compile("^(aerodrome|heliport)$");
  /** the tags map-features.ts reads: kind, code, and the names in the UI languages (en, ru, ua) */
  static final String[] PLACE_KEYS = {"place", "aeroway", "icao", "iata", "local_ref", "ref", "aerodrome", "aerodrome:type",
    "name", "name:en", "name:ru", "name:uk"};

  final ConcurrentLinkedQueue<Map<String, Object>> aerodromes = new ConcurrentLinkedQueue<>();
  final ConcurrentLinkedQueue<Map<String, Object>> places = new ConcurrentLinkedQueue<>();
  final ConcurrentLinkedQueue<Map<String, Object>> runways = new ConcurrentLinkedQueue<>();

  static String s(SourceFeature f, String k) {
    Object v = f.getTag(k);
    return v == null ? null : v.toString();
  }

  static boolean find(Pattern p, String v) {
    return v != null && p.matcher(v).find();
  }

  static boolean isBuilding(SourceFeature f) {
    String b = s(f, "building");
    return (b != null && !b.equals("no")) || f.hasTag("building:part");
  }

  /** overpass.ts isAreaTags */
  static boolean isAreaTags(SourceFeature f) {
    if ("no".equals(s(f, "area")) || "coastline".equals(s(f, "natural")) || "cliff".equals(s(f, "natural"))) return false;
    for (String k : AREA_KEYS) if (f.hasTag(k)) return true;
    return isCarPark(f) || isGraveYard(f) || find(PIER, s(f, "man_made"));
  }

  static boolean isGraveYard(SourceFeature f) {
    return "grave_yard".equals(s(f, "amenity"));
  }

  static boolean isLandZone(SourceFeature f) {
    return find(LAND_ZONE, s(f, "landuse")) || find(NATURAL_ZONE, s(f, "natural"));
  }

  static boolean isCarPark(SourceFeature f) {
    return "parking".equals(s(f, "amenity"));
  }

  /** FULL_FILTER, way statements (relation statements: multipolygons below) */
  static boolean wayWanted(SourceFeature f) {
    return f.hasTag("building") || f.hasTag("building:part") ||
      find(HIGHWAY, s(f, "highway")) ||
      find(RAILWAY, s(f, "railway")) ||
      find(AEROWAY, s(f, "aeroway")) || "aerodrome".equals(s(f, "aeroway")) ||
      find(NATURAL_WAY, s(f, "natural")) || "coastline".equals(s(f, "natural")) || "cliff".equals(s(f, "natural")) ||
      "forest".equals(s(f, "landuse")) || "farmland".equals(s(f, "landuse")) || find(ORCHARD, s(f, "landuse")) ||
      isLandZone(f) || isGraveYard(f) ||
      find(WATERWAY, s(f, "waterway")) ||
      find(LEISURE, s(f, "leisure")) || "marina".equals(s(f, "leisure")) ||
      find(PIER, s(f, "man_made")) ||
      "line".equals(s(f, "power")) || "minor_line".equals(s(f, "power")) ||
      find(LIFT, s(f, "aerialway")) ||
      isCarPark(f) ||
      isMast(f) || "lighthouse".equals(s(f, "man_made")) || f.hasTag("tomb") || find(WALL, s(f, "barrier")) ||
      "dam".equals(s(f, "waterway")) || "weir".equals(s(f, "waterway")) || "tree_row".equals(s(f, "natural"));
  }

  static boolean relationWanted(SourceFeature f) {
    return f.hasTag("building") || f.hasTag("building:part") ||
      "aerodrome".equals(s(f, "aeroway")) ||
      "water".equals(s(f, "natural")) || "wood".equals(s(f, "natural")) ||
      "forest".equals(s(f, "landuse")) || "farmland".equals(s(f, "landuse")) || find(ORCHARD, s(f, "landuse")) ||
      isLandZone(f) ||
      isCarPark(f);
  }

  static boolean isMast(SourceFeature f) {
    // with the masts: the minarets (tower:type=minaret), points or footprints (minaret-mesher.ts)
    String tt = s(f, "tower:type");
    return find(MAST, s(f, "man_made")) || ("tower".equals(s(f, "man_made")) && ("communication".equals(tt) || "minaret".equals(tt)));
  }

  static boolean nodeWanted(SourceFeature f) {
    return "helipad".equals(s(f, "aeroway")) || isMast(f) || f.hasTag("entrance") || "peak".equals(s(f, "natural")) ||
      "marina".equals(s(f, "leisure")) || find(LIFT_NODE, s(f, "aerialway")) || isSeaLight(f) || f.hasTag("tomb") || "tree".equals(s(f, "natural")) ||
      // traffic lights at junctions (osm-mesher: a post at each approach's stop line)
      "traffic_signals".equals(s(f, "highway")) || "crossing".equals(s(f, "highway"));
  }

  /** overpass.ts: lighthouses, beacons and the charted lights */
  static boolean isSeaLight(SourceFeature f) {
    String st = s(f, "seamark:type");
    return find(SEA_LIGHT, s(f, "man_made")) || (st != null && (st.equals("light_major") || st.equals("light_minor") || st.startsWith("beacon_")));
  }

  static Map<String, Object> keptTags(SourceFeature f) {
    Map<String, Object> out = new TreeMap<>();
    for (var e : f.tags().entrySet()) {
      String k = e.getKey();
      boolean keep = KEYS.contains(k) || k.equals("seamark:type");
      for (String p : SEAMARK_PREFIXES) keep |= k.startsWith(p);
      for (String p : KEY_PREFIXES) keep |= k.startsWith(p);
      if (keep && e.getValue() != null) out.put(k, e.getValue().toString());
    }
    return out;
  }

  static FeatureCollector.Feature withTags(FeatureCollector.Feature feat, Map<String, Object> tags) {
    feat.setMinZoom(Z).setPixelToleranceAtAllZooms(0).setMinPixelSizeAtAllZooms(0);
    for (var e : tags.entrySet()) feat.setAttr(e.getKey(), e.getValue());
    return feat;
  }

  @Override
  public void processFeature(SourceFeature f, FeatureCollector fc) {
    // -Dsim.debug=<osm id>: how one feature is seen (way and relation ids may collide)
    if (f.id() == Long.getLong("sim.debug", -1L)) {
      System.err.printf("DEBUG %d point=%s line=%s polygon=%s tags=%s wanted=%s%n", f.id(), f.isPoint(), f.canBeLine(), f.canBePolygon(), f.tags(), wayWanted(f));
    }
    collectPlace(f);
    if (f.isPoint()) {
      if (nodeWanted(f)) withTags(fc.point("points"), keptTags(f)).setBufferPixels(BUILDING_BUFFER_PX);
      return;
    }
    // not !canBeLine(): a closed way with area=yes cannot be a line either
    boolean relation = f instanceof OsmSourceFeature<?> o && o.originalElement().type() == OsmElement.Type.RELATION;
    if (relation ? !relationWanted(f) : !wayWanted(f)) return;
    Map<String, Object> tags = keptTags(f);
    String aeroway = s(f, "aeroway");
    try {
      if ("aerodrome".equals(aeroway) && f.canBePolygon()) {
        Geometry g = f.latLonGeometry();
        for (int i = 0; i < g.getNumGeometries(); i++) {
          if (g.getGeometryN(i) instanceof Polygon p) aerodromes.add(Map.of("tags", tags, "rings", rings(p)));
        }
        return;
      }
      boolean area = f.canBePolygon() && (isBuilding(f) || isAreaTags(f));
      if ("runway".equals(aeroway) && !area) {
        if (f.latLonGeometry() instanceof LineString l) runways.add(Map.of("tags", tags, "points", coords(l.getCoordinates())));
        return;
      }
    } catch (Exception e) {
      return; // broken geometry: Overpass would hand it over, but parseOverpass drops what does not close or has < 2 nodes
    }
    if (f.canBePolygon() && (isBuilding(f) || isAreaTags(f))) {
      var feat = withTags(fc.polygon("areas"), tags);
      if (isBuilding(f)) feat.setBufferPixels(BUILDING_BUFFER_PX);
      else if ("water".equals(s(f, "natural")) || f.hasTag("waterway")) feat.setBufferPixels(REACH_BUFFER_PX);
      else if (find(GROUND, s(f, "leisure"))) feat.setBufferPixels(GROUND_BUFFER_PX);
    } else if (!relation) {
      withTags(fc.line("lines"), tags).setBufferPixels(REACH_BUFFER_PX);
    }
  }

  /** a settlement node or an aerodrome / heliport (any geometry, at its bbox centre) for `<output>.places.json` */
  void collectPlace(SourceFeature f) {
    boolean settlement = f.isPoint() && find(PLACE, s(f, "place"));
    if (!settlement && !find(MAP_AEROWAY, s(f, "aeroway"))) return;
    Coordinate c;
    try {
      Geometry g = f.latLonGeometry();
      if (f.isPoint()) c = g.getCoordinate();
      else {
        Envelope e = g.getEnvelopeInternal();
        c = e.isNull() ? null : e.centre();
      }
    } catch (Exception e) {
      return; // broken geometry: Overpass gives it no centre either
    }
    if (c == null) return;
    Map<String, Object> tags = new TreeMap<>();
    for (String k : PLACE_KEYS) {
      String v = s(f, k);
      if (v != null) tags.put(k, v);
    }
    // an aerodrome node tagged place=* too stays an aerodrome (map-features.ts reads aeroway first)
    places.add(Map.of("type", f.isPoint() ? "node" : "way", "lat", Math.round(c.y * 1e6) / 1e6, "lon", Math.round(c.x * 1e6) / 1e6, "tags", tags));
  }

  static List<List<double[]>> rings(Polygon p) {
    List<List<double[]>> out = new ArrayList<>();
    out.add(coords(p.getExteriorRing().getCoordinates()));
    for (int i = 0; i < p.getNumInteriorRing(); i++) out.add(coords(p.getInteriorRingN(i).getCoordinates()));
    return out;
  }

  static List<double[]> coords(Coordinate[] cs) {
    List<double[]> out = new ArrayList<>(cs.length);
    for (Coordinate c : cs) out.add(new double[] {Math.round(c.x * 1e7) / 1e7, Math.round(c.y * 1e7) / 1e7});
    return out;
  }

  @Override
  public String name() {
    return "sim-unlimited";
  }

  @Override
  public String description() {
    return "sim-unlimited OSM tiles (M6 prototype): Overpass FULL_FILTER selection, raw OSM tags";
  }

  @Override
  public String attribution() {
    return "<a href=\"https://www.openstreetmap.org/copyright\">© OpenStreetMap contributors</a>";
  }

  // --- aerodrome index: a small hand-rolled JSON writer (no JSON library on planetiler's classpath is guaranteed) ---

  static void json(Writer w, Object v) throws IOException {
    if (v instanceof Map<?, ?> m) {
      w.write('{');
      boolean first = true;
      for (var e : m.entrySet()) {
        if (!first) w.write(',');
        first = false;
        json(w, e.getKey().toString());
        w.write(':');
        json(w, e.getValue());
      }
      w.write('}');
    } else if (v instanceof List<?> l) {
      w.write('[');
      for (int i = 0; i < l.size(); i++) {
        if (i > 0) w.write(',');
        json(w, l.get(i));
      }
      w.write(']');
    } else if (v instanceof Double d) {
      w.write(num(d));
    } else if (v instanceof double[] d) {
      w.write('[' + num(d[0]) + ',' + num(d[1]) + ']');
    } else {
      String str = v.toString();
      StringBuilder sb = new StringBuilder("\"");
      for (char c : str.toCharArray()) {
        if (c == '"' || c == '\\') sb.append('\\').append(c);
        else if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
        else sb.append(c);
      }
      w.write(sb.append('"').toString());
    }
  }

  static String num(double d) {
    String t = java.math.BigDecimal.valueOf(d).stripTrailingZeros().toPlainString();
    return t.equals("-0") ? "0" : t;
  }

  void writeIndex(Path path) throws IOException {
    try (Writer w = Files.newBufferedWriter(path, StandardCharsets.UTF_8)) {
      json(w, Map.of("aerodromes", new ArrayList<>(aerodromes), "runways", new ArrayList<>(runways)));
    }
  }

  void writePlaces(Path path) throws IOException {
    try (Writer w = Files.newBufferedWriter(path, StandardCharsets.UTF_8)) {
      json(w, Map.of("elements", new ArrayList<>(places)));
    }
  }

  public static void main(String[] argv) throws Exception {
    Arguments args = Arguments.fromArgsOrConfigFile(argv).orElse(Arguments.of(Map.of("minzoom", "14", "maxzoom", "14")));
    Path osm = args.file("osm", "OSM .osm.pbf extract", null);
    Path output = args.file("output", "output .pmtiles", Path.of("tiles/data/out/sim.pmtiles"));
    if (osm == null) throw new IllegalArgumentException("--osm=<extract.osm.pbf> is required");
    SimProfile profile = new SimProfile();
    Planetiler.create(args).setProfile(profile).addOsmSource("osm", osm).overwriteOutput(output).run();
    Path index = Path.of(output.toString().replaceFirst("\\.pmtiles$", "") + ".aerodromes.json");
    profile.writeIndex(index);
    System.out.printf("aerodrome index: %d aerodromes, %d runways → %s%n", profile.aerodromes.size(), profile.runways.size(), index);
    Path placesPath = Path.of(output.toString().replaceFirst("\\.pmtiles$", "") + ".places.json");
    profile.writePlaces(placesPath);
    System.out.printf("map places: %d → %s%n", profile.places.size(), placesPath);
  }
}
