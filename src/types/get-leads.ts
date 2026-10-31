/** Normalized business listing from the Get Leads search. Wire format only; results are never persisted. */
export interface GetLeadsBusiness {
  /** Outscraper place_id or a synthesized fallback. Stable row key. */
  placeId: string;
  name: string;
  category: string | null;
  fullAddress: string | null;
  city: string | null;
  phone: string | null;
  website: string | null;
  email: string | null;
  facebook: string | null;
  instagram: string | null;
  rating: number | null;
  reviewsCount: number | null;
  latitude: number | null;
  longitude: number | null;
}
