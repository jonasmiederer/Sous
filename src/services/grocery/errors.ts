/**
 * Grocery Service error model. Service methods return a GroceryServiceResult
 * and never throw for expected failures; storage read failures do throw so the
 * HTTP handler can map them to 500 and the event consumer can let EventBridge
 * retry. Each error code maps to one HTTP status in handlers.ts.
 */
export type GroceryServiceErrorCode =
  /** Malformed path parameter (e.g. a planId that is not a valid key component). */
  | 'INVALID_REQUEST'
  | 'PLAN_NOT_FOUND'
  /** GET /plans/{id}/grocery-list: no list has been generated for the plan. */
  | 'GROCERY_LIST_NOT_FOUND'
  /** A standalone shopping list does not exist. */
  | 'SHOPPING_LIST_NOT_FOUND'
  /** The household reached the maximum number of standalone shopping lists. */
  | 'TOO_MANY_SHOPPING_LISTS'
  /**
   * The stored plan cannot be consolidated: it references a Meal that is not
   * stored, or a Meal has an invalid ingredient quantity. Nothing is written.
   */
  | 'PLAN_INCONSISTENT'
  /** Concurrent writes kept winning the optimistic-concurrency race. */
  | 'GROCERY_CONFLICT'
  /** Storage write failed; prior persisted state unchanged (Requirement 8.6). */
  | 'SAVE_DID_NOT_COMPLETE';

export interface GroceryServiceError {
  code: GroceryServiceErrorCode;
  message: string;
}

export type GroceryServiceResult<T> = { ok: true; value: T } | { ok: false; error: GroceryServiceError };

export function groceryError(code: GroceryServiceErrorCode, message: string): { ok: false; error: GroceryServiceError } {
  return { ok: false, error: { code, message } };
}

export const GROCERY_ERROR_MESSAGES = {
  invalidPlanId: 'The plan id is not valid.',
  planNotFound: 'The meal plan was not found.',
  groceryListNotFound: 'No grocery list has been generated for this meal plan.',
  shoppingListNotFound: 'The grocery list was not found.',
  tooManyShoppingLists: 'There are too many grocery lists. Delete one before creating another.',
  conflict: 'The grocery list was changed concurrently; try again.',
  saveDidNotComplete: 'The save did not complete; the previously saved data is unchanged.',
} as const;
