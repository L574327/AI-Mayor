import { createClient } from '@supabase/supabase-js';
import { captureException } from '../renderer/logging';

const supabase = createClient(
  `https://${window.envVars.SUPA_PROJECT_ID}.supabase.co`,
  window.envVars.SUPA_KEY as string,
);

export async function fetchById<Type>(
  table: string,
  id: number,
  columns: string = '*',
): Promise<Type> {
  const { data, error } = await supabase
    .from(table)
    .select(columns)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    captureException(new Error(error.message));
    throw error;
  }
  return data as Type;
}

export default supabase;
