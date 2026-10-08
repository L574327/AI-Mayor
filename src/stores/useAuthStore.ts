import Debug from 'debug';
import { create } from 'zustand';
import supabase from 'vendors/supa';
import {
  AuthError,
  AuthResponse,
  Session,
  Subscription,
  User,
} from '@supabase/supabase-js';

const debug = Debug('app:stores:useAuthStore');

export interface IAuthStore {
  session: Session | null;
  user: User | null;
  load: () => Promise<AuthResponse>;
  setSession: (args: {
    accessToken: string;
    refreshToken: string;
  }) => Promise<AuthResponse>;
  getSession: () => Session | null;
  signInWithEmailAndPassword: (
    email: string,
    password: string,
  ) => Promise<AuthResponse>;
  signOut: () => Promise<{ error: AuthError | null }>;
  onAuthStateChange: (
    callback?: (event: any, session: any) => void,
  ) => Subscription;
  saveInactiveUser: (user: User) => void;
}

const useAuthStore = create<IAuthStore>((set, get) => ({
  session: null,
  user: null,
  /**
   * There are several scenarios for loading:
   * 1. No session exists locally.
   *   1.1 No user information is available.
   *   1.2 User information exists. This is a special case, which can only occur when the user has just registered
   *       and has not yet confirmed activation via email. In this case, we need to retrieve the local InactiveUser
   *       as the user information.
   * 2. A session exists locally.
   *    2.1 The session is valid. Return it.
   *    2.2 The session has expired. Return null.
   */
  load: async () => {
    const { data, error } = await supabase.auth.getSession();
    let user = null;
    let { session } = data;
    if (error) {
      debug('loadSession error', error);
      return {
        data: {
          session,
          user,
        },
        error,
      } as AuthResponse;
    }
    debug('loadSession', session);
    if (session) {
      if ((session.expires_at as number) >= Date.now()) {
        session = null;
      } else {
        user = session.user;
      }
    } else {
      const serialized = localStorage.getItem('inactive-user');
      if (serialized) {
        user = JSON.parse(serialized) as User;
      }
    }
    set({ session, user });
    return {
      data: {
        session,
        user,
      },
      error: null,
    } as AuthResponse;
  },

  setSession: async (args) => {
    const resp = await supabase.auth.setSession({
      access_token: args.accessToken,
      refresh_token: args.refreshToken,
    });
    debug('setSession data', resp.data);
    set({
      session: resp.data.session,
      user: resp.data.user,
    });
    return resp;
  },

  getSession: () => {
    const localKey = `sb-${window.envVars.SUPA_PROJECT_ID}-auth-token`;
    const sessionString = localStorage.getItem(localKey);
    let session = null;
    if (sessionString) {
      try {
        session = JSON.parse(sessionString);
        if ((session.expires_at as number) >= Date.now()) {
          session = null;
        }
      } catch (err) {
        debug('getLocalSession error', err);
      }
    }
    return session;
  },

  onAuthStateChange: (callback?: (event: any, session: any) => void) => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (session?.user?.id === get().user?.id) return;
      if (callback) callback(event, session);
      set({ session, user: session?.user });
      debug('onAuthStateChange', event, session);
    });
    return subscription;
  },
  signInWithEmailAndPassword: async (email: string, password: string) => {
    const resp = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    const { session, user } = resp.data;
    set({ session, user });
    return resp;
  },
  signOut: async () => {
    localStorage.removeItem('inactive-user');
    const { error } = await supabase.auth.signOut();
    if (error) {
      debug('signOut error', error);
    } else {
      set({ session: null, user: null });
    }
    return { error };
  },
  saveInactiveUser(user: User) {
    localStorage.setItem('inactive-user', JSON.stringify(user));
    set({ user });
  },
}));

export default useAuthStore;
