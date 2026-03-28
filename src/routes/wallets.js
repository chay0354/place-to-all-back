import { Router } from 'express';
import { supabase } from '../index.js';

export const walletsRouter = Router();

/** Get all wallets for the authenticated user (userId from header) */
walletsRouter.get('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });

    const { data, error } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .order('currency');

    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Get one wallet by id (must belong to user) */
walletsRouter.get('/:id', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });

    const { data, error } = await supabase
      .from('wallets')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', userId)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Wallet not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
