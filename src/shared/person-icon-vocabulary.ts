// Local vocabulary augments upstream tags without renaming the actual Lucide icon.
export const ICON_EXTRA_TAGS: Record<string, string[]> = {
  'flower-2': [
    'lotus',
    'water lily',
    'petals',
    'bloom',
    'blossom',
    'garden',
    'floral',
    'botanical',
  ],
  flower: ['flower', 'rose', 'tulip', 'daisy', 'sunflower', 'petals', 'garden', 'floral'],
  'user-round': ['person', 'self', 'patient', 'human', 'profile'],
  stethoscope: ['doctor', 'physician', 'nurse', 'primary care', 'specialist'],
  'party-popper': ['jester', 'clown', 'celebration', 'confetti'],
  'venetian-mask': ['jester', 'theatre', 'theater', 'masquerade'],
  cookie: ['cookie dough', 'baking', 'biscuit'],
  'a-arrow-down': ['decrease', 'shrink', 'reduce', 'typography'],
  'a-arrow-up': ['increase', 'grow', 'enlarge', 'typography'],
  'a-large-small': ['resize', 'typography', 'text size'],
  accessibility: ['a11y', 'assistive technology', 'accommodation', 'universal access'],
  activity: ['heartbeat', 'cardiogram', 'electrocardiogram', 'ecg', 'ekg'],
  ad: ['advertisement', 'promotion', 'sponsored', 'billboard', 'banner'],
  'air-vent': ['ventilation', 'hvac', 'duct', 'ductwork', 'airflow', 'grille'],
  airplay: ['broadcast', 'screencast', 'wireless display', 'television'],
  'alarm-clock-check': ['acknowledge', 'confirmed', 'verified', 'alarm set'],
  'alarm-clock-minus': ['cancel', 'delete', 'unschedule', 'remove alarm'],
  'alarm-clock-off': ['disable', 'mute', 'silent', 'deactivate'],
  'alarm-clock-plus': ['create', 'schedule', 'set alarm', 'new alarm'],
  'alarm-clock': ['wake', 'wake-up', 'reminder', 'ringing'],
  'alarm-smoke': ['co alarm', 'fumes', 'combustion', 'toxic gas'],
  album: ['photo album', 'scrapbook', 'gallery', 'music collection', 'record', 'vinyl'],
  'align-center-horizontal': ['horizontal alignment', 'centered horizontally', 'middle'],
  'align-center-vertical': ['vertical alignment', 'centered vertically', 'middle'],
};

// Lucide exposes these shorter names as imports of the canonical alarm-clock icons.
export const ICON_SEARCH_ALIASES: Record<string, string> = {
  'alarm-check': 'alarm-clock-check',
  'alarm-minus': 'alarm-clock-minus',
  'alarm-plus': 'alarm-clock-plus',
};
