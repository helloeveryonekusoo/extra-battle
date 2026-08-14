import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App';

describe('App', () => {
  it('部屋に入っていないときはロビーを出す', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /ポケカ エクストラ/ })).toBeTruthy();
    expect(screen.getByPlaceholderText('あなたの名前')).toBeTruthy();
  });
});
