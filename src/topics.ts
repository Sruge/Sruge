/** Topic filters. `gdelt` is a GDELT DOC 2.0 query fragment, `guardian` a Guardian section/tag filter. */
export interface Topic {
  id: string;
  label: string;
  gdelt: string;
  guardian?: string;
}

export const TOPICS: Topic[] = [
  { id: 'all', label: 'All', gdelt: '' },
  {
    id: 'politics',
    label: 'Politics',
    gdelt: '(theme:ELECTION OR theme:LEGISLATION OR theme:GENERAL_GOVERNMENT OR parliament OR election)',
    guardian: 'politics',
  },
  {
    id: 'economy',
    label: 'Economy',
    gdelt: '(theme:EPU_ECONOMY OR theme:ECON_STOCKMARKET OR theme:ECON_INFLATION OR economy OR inflation)',
    guardian: 'business',
  },
  {
    id: 'conflict',
    label: 'Conflict',
    gdelt: '(theme:ARMEDCONFLICT OR theme:MILITARY OR theme:TERROR OR theme:KILL)',
    guardian: 'world',
  },
  {
    id: 'climate',
    label: 'Climate',
    gdelt: '(theme:ENV_CLIMATECHANGE OR theme:NATURAL_DISASTER OR climate OR wildfire OR flood)',
    guardian: 'environment',
  },
  {
    id: 'health',
    label: 'Health',
    gdelt: '(theme:GENERAL_HEALTH OR theme:MEDICAL OR theme:HEALTH_PANDEMIC OR hospital OR vaccine)',
    guardian: 'society',
  },
  {
    id: 'tech',
    label: 'Tech & Science',
    gdelt: '(technology OR "artificial intelligence" OR startup OR science OR research OR theme:CYBER_ATTACK)',
    guardian: 'technology',
  },
  {
    id: 'sports',
    label: 'Sports',
    gdelt: '(football OR soccer OR olympics OR tennis OR basketball OR cricket OR championship)',
    guardian: 'sport',
  },
  {
    id: 'culture',
    label: 'Culture',
    gdelt: '(film OR music OR festival OR museum OR exhibition OR theatre)',
    guardian: 'culture',
  },
];
