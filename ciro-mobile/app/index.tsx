import React, { useEffect, useState, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  FlatList,
  SafeAreaView,
  TouchableOpacity,
  Animated,
  PanResponder,
} from 'react-native';
import MapView, { Marker, Callout } from 'react-native-maps';
import { collection, onSnapshot, query, orderBy, limit } from 'firebase/firestore';
import { db } from '../firebaseConfig';
import { Stack } from 'expo-router';

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTime(timestamp: any): string {
  if (!timestamp) return '';
  try {
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function getSeverityColor(severity: number): string {
  if (severity >= 8) return '#ff4b4b';
  if (severity >= 5) return '#ff9f43';
  return '#ffd93d';
}

function getSeverityLabel(severity: number): string {
  if (severity >= 8) return 'CRITICAL';
  if (severity >= 5) return 'MODERATE';
  return 'LOW';
}

function getMarkerSize(severity: number): number {
  return 10 + severity * 1.4;
}

function getActionColor(actionType: string): string {
  const type = (actionType || '').toUpperCase();
  if (['ALERT', 'CRITICAL', 'EMERGENCY'].includes(type)) return '#ff6b6b';
  if (['WARNING', 'DISPATCH'].includes(type)) return '#ff9f43';
  if (['RESOLVED', 'COMPLETE', 'CLEARED'].includes(type)) return '#69db7c';
  return '#4dabf7';
}

function calcAverageETA(logs: any[]): string {
  const etaLogs = logs.filter(l => l.expected_impact?.toLowerCase().includes('eta'));
  if (!etaLogs.length) return '--';
  const minutes = etaLogs
    .map(l => parseInt(l.expected_impact?.match(/\d+/)?.[0] || '0'))
    .filter(n => n > 0);
  if (!minutes.length) return '--';
  const avg = Math.round(minutes.reduce((a, b) => a + b, 0) / minutes.length);
  return `${avg}m`;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

interface CrisisMarkerProps {
  crisis: any;
}

// ── log_level → terminal text colour ─────────────────────────────────────────
function getSwarmLogColor(logLevel: string | undefined): string {
  switch ((logLevel || '').toLowerCase()) {
    case 'warning':  return '#ffb020'; // amber
    case 'critical': return '#ff4b4b'; // emergency red
    case 'info':     // fall-through
    default:         return '#39ff14'; // neon green
  }
}

// ── resource status → marker colour ──────────────────────────────────────────
function getResourceColor(status: string | undefined): string {
  switch ((status || '').toLowerCase()) {
    case 'dispatched': return '#ff9f43'; // active orange/yellow warning glow
    case 'on_scene':   return '#69db7c'; // operational response green
    case 'available':  // fall-through
    default:           return '#4dabf7'; // calm slate blue
  }
}

function getResourceStatusLabel(status: string | undefined): string {
  switch ((status || '').toLowerCase()) {
    case 'dispatched': return '▶ Dispatched';
    case 'on_scene':   return '● On Scene';
    case 'available':  return '○ Available';
    default:           return `${status || 'unknown'}`;
  }
}

function CrisisMarker({ crisis }: CrisisMarkerProps) {
  const severity = crisis.severity ?? 5;
  const color = getSeverityColor(severity);
  const size = getMarkerSize(severity);

  // ── Lifecycle opacity: mute resolved/resolving crises so they don't create
  // visual noise — active crises stay at full opacity.
  const status = (crisis.status || 'active').toLowerCase();
  const markerOpacity = status === 'resolved' ? 0.28 : status === 'resolving' ? 0.52 : 1;
  // Greyscale tint for resolved markers (transform the colour to a muted slate).
  const resolvedTint = status === 'resolved' ? '#8a9099' : undefined;
  const markerColor = resolvedTint ?? color;

  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    // Only pulse active, high-severity crises — not resolved/resolving ones.
    if (severity >= 8 && status === 'active') {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.6, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
        ])
      ).start();
    }
  }, [severity, status]);

  // ── Coordinate extraction hierarchy:
  //   1. root `location.latitude / longitude`   (legacy + Phase 2 Analysis Agent output)
  //   2. root `inferred_location.lat / lng`     (Phase 1 Ingestion Agent output promoted to doc root)
  //   3. randomised offset around Islamabad     (last-resort demo fallback)
  // 1. Check for real hardware location coordinates
let lat = crisis.location?.latitude;
let lng = crisis.location?.longitude;

// 2. Fall back to our new Phase 1 AI inferred location if root location is missing
if (!lat || !lng) {
  lat = crisis.inferred_location?.lat;
  lng = crisis.inferred_location?.lng;
}

// 3. If BOTH are missing, use a stable hash of the document ID instead of Math.random()
if (!lat || !lng) {
  let hash = 0;
  const id = crisis.id || "default";
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  // This creates a fixed, repeatable offset between -0.005 and +0.005 based on the ID string
  const latOffset = ((hash % 100) / 10000) - 0.005;
  const lngOffset = (((hash >> 5) % 100) / 10000) - 0.005;

  lat = 33.673 + latOffset;
  lng = 73.012 + lngOffset;
}

  return (
    
    <Marker coordinate={{ latitude: lat, longitude: lng }} anchor={{ x: 0.5, y: 0.5 }}>
      <View
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          width: size + 24,
          height: size + 24,
          opacity: markerOpacity,
        }}
      >
        {severity >= 8 && status === 'active' && (
          <Animated.View
            style={{
              position: 'absolute',
              width: size + 16,
              height: size + 16,
              borderRadius: (size + 16) / 2,
              backgroundColor: markerColor,
              opacity: 0.25,
              transform: [{ scale: pulseAnim }],
            }}
          />
        )}
        <View
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: markerColor,
            borderWidth: 2,
            borderColor: status !== 'active' ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.4)',
          }}
        />
      </View>
      <Callout tooltip>
        <View style={styles.calloutBox}>
          <View style={[styles.calloutSeverityBadge, { backgroundColor: markerColor + '22', borderColor: markerColor }]}>
            <Text style={[styles.calloutSeverityText, { color: markerColor }]}>{getSeverityLabel(severity)}</Text>
          </View>
          <Text style={styles.calloutTitle}>{crisis.type ?? 'Unknown Crisis'}</Text>
          <Text style={styles.calloutMeta}>Severity: {severity}/10</Text>
          {crisis.affected_population && (
            <Text style={styles.calloutMeta}>Affected: {crisis.affected_population}</Text>
          )}
          {crisis.location?.locality_name && (
            <Text style={styles.calloutMeta}>📍 {crisis.location.locality_name}</Text>
          )}
          {crisis.status && (
            <Text style={[styles.calloutMeta, { textTransform: 'capitalize' }]}>Status: {crisis.status}</Text>
          )}
        </View>
      </Callout>
    </Marker>
  );
}

interface ResourceMarkerProps {
  resource: any;
}

function ResourceMarker({ resource }: ResourceMarkerProps) {
  if (!resource.current_location) return null;

  // Multi-state colour: available → slate blue, dispatched → orange, on_scene → green
  const color = getResourceColor(resource.status);
  const statusLabel = getResourceStatusLabel(resource.status);

  return (
    <Marker
      coordinate={{
        latitude: resource.current_location.latitude ?? resource.current_location.lat,
        longitude: resource.current_location.longitude ?? resource.current_location.lng,
      }}
      anchor={{ x: 0.5, y: 0.5 }}
    >
      <View style={[styles.resourceDot, { backgroundColor: color, shadowColor: color }]} />
      <Callout tooltip>
        <View style={styles.calloutBox}>
          <Text style={styles.calloutTitle}>{resource.type ?? 'Resource'}</Text>
          <Text style={[styles.calloutMeta, { color }]}>{statusLabel}</Text>
          {resource.unit_id && <Text style={styles.calloutMeta}>Unit: {resource.unit_id}</Text>}
          {resource.assigned_crisis_id && (
            <Text style={styles.calloutMeta} numberOfLines={1}>Crisis: {resource.assigned_crisis_id}</Text>
          )}
        </View>
      </Callout>
    </Marker>
  );
}

interface KpiCardProps {
  label: string;
  value: string | number;
  sub?: string;
  valueColor: string;
}

function KpiCard({ label, value, sub, valueColor }: KpiCardProps) {
  return (
    <View style={styles.kpiCard}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={[styles.kpiValue, { color: valueColor }]}>{value}</Text>
      {sub ? <Text style={styles.kpiSub}>{sub}</Text> : null}
    </View>
  );
}

interface LogItemProps {
  item: any;
}

function LogItem({ item }: LogItemProps) {
  const accentColor = getActionColor(item.action_type);
  return (
    <View style={[styles.logItem, { borderLeftColor: accentColor }]}>
      <View style={styles.logTopRow}>
        <Text style={[styles.logAction, { color: accentColor }]}>
          {item.action_type || 'UPDATE'}
        </Text>
        <Text style={styles.logTimestamp}>{formatTime(item.timestamp)}</Text>
      </View>
      <Text style={styles.logDescription}>{item.description}</Text>
      {item.expected_impact && (
        <Text style={styles.logImpact}>{item.expected_impact}</Text>
      )}
    </View>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

const FEED_COLLAPSED_HEIGHT = 220;
const FEED_EXPANDED_HEIGHT = 400;

export default function MapDashboard() {
  const [crises, setCrises] = useState<any[]>([]);
  const [resources, setResources] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [swarmLogs, setSwarmLogs] = useState<any[]>([]);
  const [terminalExpanded, setTerminalExpanded] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const [currentTime, setCurrentTime] = useState('');

  // Animated feed height
  const feedHeight = useRef(new Animated.Value(FEED_COLLAPSED_HEIGHT)).current;
  const [feedExpanded, setFeedExpanded] = useState(false);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dy) > 5,
      onPanResponderMove: (_, gs) => {
        if (gs.dy < 0) {
          // dragging up → expand
          const next = Math.min(FEED_COLLAPSED_HEIGHT + Math.abs(gs.dy), FEED_EXPANDED_HEIGHT);
          feedHeight.setValue(next);
        } else if (gs.dy > 0) {
          // dragging down → collapse
          const next = Math.max(FEED_EXPANDED_HEIGHT - gs.dy, FEED_COLLAPSED_HEIGHT);
          feedHeight.setValue(next);
        }
      },
      onPanResponderRelease: (_, gs) => {
        const expanded = gs.dy < -40;
        setFeedExpanded(expanded);
        Animated.spring(feedHeight, {
          toValue: expanded ? FEED_EXPANDED_HEIGHT : FEED_COLLAPSED_HEIGHT,
          useNativeDriver: false,
          tension: 60,
          friction: 10,
        }).start();
      },
    })
  ).current;

  // Clock
  useEffect(() => {
    const tick = () => {
      setCurrentTime(new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' }));
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const unsubCrises = onSnapshot(
      collection(db, 'ActiveCrises'),
      (snapshot) => {
        setIsConnected(true);
        setCrises(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      },
      (error) => {
        setIsConnected(false);
        console.error('Error fetching ActiveCrises:', error);
      }
    );

    const unsubResources = onSnapshot(
      collection(db, 'Resources'),
      (snapshot) => {
        setResources(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      },
      (error) => console.error('Error fetching Resources:', error)
    );

    const logsQuery = query(collection(db, 'ActionLogs'), orderBy('timestamp', 'desc'), limit(8));
    const unsubLogs = onSnapshot(
      logsQuery,
      (snapshot) => setLogs(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))),
      (error) => console.error('Error fetching ActionLogs:', error)
    );

    const swarmQuery = query(collection(db, 'SwarmActivity'), orderBy('timestamp', 'desc'), limit(4));
    const unsubSwarm = onSnapshot(
      swarmQuery,
      (snapshot) => setSwarmLogs(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))),
      (error) => console.error('Error fetching SwarmActivity:', error)
    );

    return () => {
      unsubCrises();
      unsubResources();
      unsubLogs();
      unsubSwarm();
    };
  }, []);

  // ── KPI derivations (multi-state aware) ─────────────────────────────────
  const availableCount  = resources.filter(r => r.status === 'available').length;
  const dispatchedCount = resources.filter(r => r.status === 'dispatched').length;
  const onSceneCount    = resources.filter(r => r.status === 'on_scene').length;
  const activeCount     = crises.filter(c => (c.status || 'active') === 'active').length;
  const avgETA = calcAverageETA(logs);
  const criticalCount = crises.filter(c => (c.severity ?? 0) >= 8 && (c.status || 'active') === 'active').length;

  return (
    <View style={styles.container}>
      {/* Hides the default white "index" header bar */}
      <Stack.Screen options={{ headerShown: false }} />
      {/* ── Map ── */}
      <MapView
        style={styles.map}
        initialRegion={{
          latitude: 33.673,
          longitude: 73.012,
          latitudeDelta: 0.0922,
          longitudeDelta: 0.0421,
        }}
      >
        {crises.map(crisis => (
          <CrisisMarker key={crisis.id} crisis={crisis} />
        ))}
        {resources.map(resource => (
          <ResourceMarker key={resource.id} resource={resource} />
        ))}
      </MapView>

      {/* ── Status bar ── */}
      <SafeAreaView style={styles.statusBar} pointerEvents="none">
        <View style={[styles.connectionBadge, { borderColor: isConnected ? 'rgba(16,185,129,0.4)' : 'rgba(255,75,75,0.4)' }]}>
          <View style={[styles.connectionDot, { backgroundColor: isConnected ? '#10b981' : '#ff4b4b' }]} />
          <Text style={[styles.connectionText, { color: isConnected ? '#6ee7b7' : '#ff9f9f' }]}>
            {isConnected ? 'Live' : 'Reconnecting'}
          </Text>
        </View>
        <Text style={styles.clockText}>{currentTime} PKT</Text>
      </SafeAreaView>

      {/* ── KPI strip ── */}
      <View style={styles.kpiRow} pointerEvents="none">
        <KpiCard
          label="Active Crises"
          value={activeCount}
          sub={criticalCount > 0 ? `${criticalCount} critical` : 'none critical'}
          valueColor="#ff6b6b"
        />
        <KpiCard
          label="Resources"
          value={resources.length}
          sub={`${dispatchedCount + onSceneCount} deployed`}
          valueColor="#74c0fc"
        />
        <KpiCard
          label="On Scene"
          value={onSceneCount}
          sub={`${availableCount} available`}
          valueColor="#69db7c"
        />
      </View>

      {/* ── Agent terminal ── */}
      <View style={styles.terminal}>
        <TouchableOpacity
          style={styles.terminalHeader}
          onPress={() => setTerminalExpanded(v => !v)}
          activeOpacity={0.7}
        >
          <View style={styles.trafficLights}>
            <View style={[styles.trafficDot, { backgroundColor: '#ff5f57' }]} />
            <View style={[styles.trafficDot, { backgroundColor: '#ffbd2e' }]} />
            <View style={[styles.trafficDot, { backgroundColor: '#28c840' }]} />
          </View>
          <Text style={styles.terminalTitle}>agent terminal</Text>
          <Text style={styles.terminalToggle}>{terminalExpanded ? '▲ hide' : '▼ show'}</Text>
        </TouchableOpacity>

        {terminalExpanded && swarmLogs.map((log) => {
          const logColor = getSwarmLogColor(log.log_level);
          return (
            <View key={log.id} style={styles.terminalLine}>
              {/* Agent name always neon-green — the identifier anchor */}
              <Text style={styles.terminalAgent} numberOfLines={1}>
                [{log.agent_name || 'SYSTEM'}]
              </Text>
              {/* Message colour is driven by log_level from Firestore */}
              <Text
                style={[styles.terminalMessage, { color: logColor }]}
                numberOfLines={1}
              >
                {log.message}
              </Text>
            </View>
          );
        })}

        {terminalExpanded && swarmLogs.length === 0 && (
          <Text style={styles.terminalEmpty}>Waiting for agent activity...</Text>
        )}
      </View>

      {/* ── Marker legend ── */}
      <View style={styles.legend} pointerEvents="none">
        {[
          { color: '#ff4b4b', label: 'Critical' },
          { color: '#ff9f43', label: 'Moderate' },
          { color: '#ffd93d', label: 'Low' },
          { color: '#69db7c', label: 'On Scene' },
          { color: '#ff9f43', label: 'Dispatched' },
          { color: '#4dabf7', label: 'Available' },
        ].map(({ color, label }) => (
          <View key={label} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: color }]} />
            <Text style={styles.legendLabel}>{label}</Text>
          </View>
        ))}
      </View>

      {/* ── Incident feed ── */}
      <Animated.View style={[styles.feedContainer, { height: feedHeight }]}>
        {/* Drag handle */}
        <View {...panResponder.panHandlers} style={styles.dragArea}>
          <View style={styles.dragHandle} />
        </View>

        <View style={styles.feedHeaderRow}>
          <Text style={styles.feedHeader}>Incident Feed</Text>
          <View style={styles.liveBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>LIVE</Text>
          </View>
        </View>

        <FlatList
          data={logs}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <LogItem item={item} />}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 8 }}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No recent actions</Text>
          }
        />
      </Animated.View>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { width: '100%', height: '100%' },

  // Status bar
  statusBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: 8,
    gap: 10,
    zIndex: 30,
  },
  connectionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1,
    borderRadius: 100,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  connectionDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  connectionText: {
    fontSize: 11,
    fontWeight: '600',
  },
  clockText: {
    marginLeft: 'auto',
    fontSize: 11,
    color: 'rgba(255,255,255,0.5)',
    fontFamily: 'monospace',
  },

  // KPI row
  kpiRow: {
    position: 'absolute',
    top: 52,
    left: 10,
    right: 10,
    flexDirection: 'row',
    gap: 8,
    zIndex: 20,
  },
  kpiCard: {
    flex: 1,
    backgroundColor: 'rgba(8,12,28,0.82)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  kpiLabel: {
    fontSize: 9,
    color: 'rgba(255,255,255,0.45)',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  kpiValue: {
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 24,
  },
  kpiSub: {
    fontSize: 9,
    color: 'rgba(255,255,255,0.3)',
    marginTop: 3,
  },

  // Terminal
  terminal: {
    position: 'absolute',
    top: 136,
    left: 10,
    right: 10,
    zIndex: 20,
    backgroundColor: 'rgba(0,0,0,0.78)',
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: 'rgba(57,255,20,0.2)',
  },
  terminalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    gap: 8,
  },
  trafficLights: {
    flexDirection: 'row',
    gap: 4,
  },
  trafficDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  terminalTitle: {
    fontSize: 9,
    color: 'rgba(57,255,20,0.6)',
    fontFamily: 'monospace',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  terminalToggle: {
    marginLeft: 'auto',
    fontSize: 9,
    color: 'rgba(57,255,20,0.5)',
    fontFamily: 'monospace',
  },
  terminalLine: {
    flexDirection: 'row',
    marginBottom: 4,
    gap: 6,
  },
  terminalAgent: {
    color: '#39ff14',
    fontWeight: 'bold',
    fontFamily: 'monospace',
    fontSize: 11,
    flexShrink: 0,
  },
  terminalMessage: {
    color: '#e0e0e0',
    fontFamily: 'monospace',
    fontSize: 11,
    flexShrink: 1,
  },
  terminalEmpty: {
    color: 'rgba(57,255,20,0.3)',
    fontFamily: 'monospace',
    fontSize: 10,
    fontStyle: 'italic',
  },

  // Legend
  legend: {
    position: 'absolute',
    bottom: 235,
    right: 10,
    backgroundColor: 'rgba(8,12,28,0.85)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    padding: 10,
    zIndex: 15,
    gap: 6,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendLabel: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.55)',
  },

  // Feed
  feedContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(8,12,28,0.92)',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    zIndex: 20,
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  dragArea: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  dragHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  feedHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.07)',
  },
  feedHeader: {
    color: '#f8f9fa',
    fontSize: 15,
    fontWeight: '700',
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#ff6b6b',
  },
  liveText: {
    fontSize: 10,
    color: '#ff6b6b',
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  logItem: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 10,
    padding: 11,
    marginBottom: 7,
    borderLeftWidth: 3,
    borderLeftColor: '#4dabf7',
  },
  logTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  logAction: {
    fontWeight: '700',
    textTransform: 'uppercase',
    fontSize: 10,
    letterSpacing: 0.5,
  },
  logTimestamp: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.3)',
    fontFamily: 'monospace',
  },
  logDescription: {
    color: '#f1f3f5',
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 4,
  },
  logImpact: {
    color: '#69db7c',
    fontSize: 11,
    fontStyle: 'italic',
  },
  emptyText: {
    color: '#868e96',
    fontStyle: 'italic',
    textAlign: 'center',
    paddingVertical: 20,
  },

  // Callout
  calloutBox: {
    backgroundColor: 'rgba(8,12,28,0.95)',
    borderRadius: 10,
    padding: 12,
    minWidth: 140,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  calloutSeverityBadge: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginBottom: 6,
  },
  calloutSeverityText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  calloutTitle: {
    color: '#f8f9fa',
    fontWeight: '600',
    fontSize: 13,
    marginBottom: 5,
    textTransform: 'capitalize',
  },
  calloutMeta: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 11,
    marginBottom: 2,
  },

  // Resource dot
  resourceDot: {
    width: 11,
    height: 11,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.25)',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 6,
    elevation: 4,
  },
});