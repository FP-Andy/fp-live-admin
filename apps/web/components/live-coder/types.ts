export type BroadcastGraphic = null | 'ATTACK_DIRECTION_HOME' | 'ATTACK_DIRECTION_AWAY' | 'ATTACK_DIRECTION_BOTH' | 'XG';
export type BroadcastEventGraphic = null | 'GOAL' | 'YELLOW_CARD' | 'RED_CARD' | 'SUBSTITUTION';
export type BroadcastFullscreenGraphic = null | 'LINEUP' | 'HALFTIME' | 'FULLTIME' | 'MATCH_DOMINANCE';

export type BroadcastState = {
  match_id: string;
  sport: 'FOOTBALL' | 'BASKETBALL';
  scoreboard_visible: boolean;
  possession_visible: boolean;
  active_graphic: BroadcastGraphic;
  selected_xg_event_id?: string | null;
  event_graphic: BroadcastEventGraphic;
  fullscreen_graphic: BroadcastFullscreenGraphic;
  fullscreen_image_urls?: Record<string, string>;
  theme_id: string;
  home_label: string;
  away_label: string;
  home_color: string;
  away_color: string;
  home_logo_url?: string | null;
  away_logo_url?: string | null;
  home_score: number | null;
  away_score: number | null;
  clock_ms: number;
  clock_running: boolean;
  clock_started_at?: string | null;
  sequence: number;
  event_payload?: Record<string, unknown> | null;
  updated_at: string;
};

export type BroadcastSnapshot = {
  match: {
    id: string;
    name: string;
    sport: 'FOOTBALL' | 'BASKETBALL';
    home: { name: string; score: number };
    away: { name: string; score: number };
    clock: string;
    clock_ms: number;
    running: boolean;
    fla_clock?: string;
    fla_clock_ms?: number;
  };
  broadcast_state: BroadcastState;
  analysis: {
    possession?: { home_pct?: number; away_pct?: number } | null;
    attack_direction?: Array<{
      team: 'HOME' | 'AWAY';
      direction_ratio?: { left_pct?: number; center_pct?: number; right_pct?: number; total_count?: number };
    }>;
    xg?: Array<{
      team: 'HOME' | 'AWAY';
      xg?: number;
      xgot?: number;
      player_name?: string | null;
      player_number?: string | null;
      event_clock_ms?: number;
      event_clock?: string;
      is_goal?: boolean;
      event_id?: string;
      shot_x?: number | null;
      shot_y?: number | null;
      goalmouth_x?: number | null;
      goalmouth_y?: number | null;
    }>;
    match_dominance?: {
      items?: Array<{
        base_time?: string;
        base_time_ms?: number;
        dominance?: number;
        annotations?: {
          goal_summary?: { home?: number; away?: number; total?: number };
          markers?: string[];
        };
      }>;
    } | null;
  };
  updated_at: string;
};

export type MatchListItem = {
  id: string;
  name: string;
  sport?: 'FOOTBALL' | 'BASKETBALL';
  competition_class: string;
  round_number: number;
  archived: boolean;
  created_at: string;
  metadata?: {
    home_team?: string;
    away_team?: string;
    broadcast?: Partial<BroadcastState>;
  } | null;
};
