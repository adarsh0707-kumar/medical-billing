import { useState, useEffect, useCallback } from 'react'
import {
  Truck, Plus, Search, Edit2, Phone,
  Mail, MapPin, Package, Loader2, Building2
} from 'lucide-react'
import { toast } from 'sonner'
import api from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle
} from '@/components/ui/dialog'

// ─── Types ─────────────────────────────────────────────

interface Supplier {
  id: string
  name: string
  contactName?: string
  phone?: string
  email?: string
  gstNumber?: string
  address?: string
  createdAt: string
}

// ─── Helpers ───────────────────────────────────────────

const inputCls = "bg-slate-700 border-slate-600 text-white placeholder:text-slate-500 focus:border-teal-500 h-9"

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-slate-300 text-sm">{label}</Label>
      {children}
    </div>
  )
}

const SUPPLIER_COLORS = [
  'from-teal-600 to-teal-800',
  'from-blue-600 to-blue-800',
  'from-purple-600 to-purple-800',
  'from-orange-600 to-orange-800',
  'from-rose-600 to-rose-800',
]

// ─── Main Suppliers Page ────────────────────────────────

export default function Suppliers() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Supplier | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState({
    name: '', contactName: '', phone: '',
    email: '', gstNumber: '', address: ''
  })

  const fetchSuppliers = useCallback(async () => {
    setLoading(true)
    try {
      const params = search ? `?search=${search}` : ''
      const res = await api.get(`/api/inventory/suppliers${params}`)
      setSuppliers(res.data.data)
    } catch { toast.error('Failed to fetch suppliers') }
    finally { setLoading(false) }
  }, [search])

  useEffect(() => { fetchSuppliers() }, [fetchSuppliers])

  const openAdd = () => {
    setEditing(null)
    setForm({ name: '', contactName: '', phone: '', email: '', gstNumber: '', address: '' })
    setShowForm(true)
  }

  const openEdit = (s: Supplier) => {
    setEditing(s)
    setForm({
      name: s.name, contactName: s.contactName || '',
      phone: s.phone || '', email: s.email || '',
      gstNumber: s.gstNumber || '', address: s.address || ''
    })
    setShowForm(true)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    try {
      if (editing) {
        await api.put(`/api/inventory/suppliers/${editing.id}`, form)
        toast.success('Supplier updated!')
      } else {
        await api.post('/api/inventory/suppliers', form)
        toast.success('Supplier added!')
      }
      setShowForm(false)
      fetchSuppliers()
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } }
      toast.error(e.response?.data?.message || 'Failed to save')
    } finally { setSubmitting(false) }
  }

  const filtered = suppliers.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.phone?.includes(search) ||
    s.contactName?.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Suppliers</h2>
          <p className="text-slate-400 mt-1 text-sm">Manage your medicine suppliers and vendors</p>
        </div>
        <Button onClick={openAdd} className="bg-teal-600 hover:bg-teal-500 text-white">
          <Plus className="w-4 h-4 mr-1" /> Add Supplier
        </Button>
      </div>

      <Separator className="bg-slate-800" />

      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <Input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search suppliers..."
            className={`pl-9 ${inputCls}`} />
        </div>
        <Badge className="bg-slate-700 text-slate-300">{filtered.length} suppliers</Badge>
      </div>

      {/* Suppliers Grid */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-500">
          <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading suppliers...
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-slate-600">
          <Truck className="w-12 h-12 mb-3 opacity-20" />
          <p>No suppliers found</p>
          <Button onClick={openAdd} size="sm"
            className="mt-3 bg-teal-600 hover:bg-teal-500 text-white">
            Add First Supplier
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((s, idx) => (
            <Card key={s.id}
              className="bg-slate-800 border-slate-700 hover:border-slate-600 transition-all group overflow-hidden">

              {/* Color Bar */}
              <div className={`h-1.5 bg-gradient-to-r ${SUPPLIER_COLORS[idx % SUPPLIER_COLORS.length]}`} />

              <CardContent className="pt-4 pb-4">

                {/* Header */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl bg-gradient-to-br
                      ${SUPPLIER_COLORS[idx % SUPPLIER_COLORS.length]}
                      flex items-center justify-center shrink-0`}>
                      <Building2 className="w-5 h-5 text-white" />
                    </div>
                    <div>
                      <p className="text-white font-semibold text-sm">{s.name}</p>
                      {s.contactName && (
                        <p className="text-slate-400 text-xs">{s.contactName}</p>
                      )}
                    </div>
                  </div>
                  <button onClick={() => openEdit(s)}
                    className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md
                      text-slate-400 hover:text-teal-400 hover:bg-slate-700 transition-all">
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                <Separator className="bg-slate-700 mb-3" />

                {/* Contact Details */}
                <div className="space-y-1.5 text-xs">
                  {s.phone && (
                    <div className="flex items-center gap-2 text-slate-400">
                      <Phone className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <span>{s.phone}</span>
                    </div>
                  )}
                  {s.email && (
                    <div className="flex items-center gap-2 text-slate-400">
                      <Mail className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <span className="truncate">{s.email}</span>
                    </div>
                  )}
                  {s.address && (
                    <div className="flex items-center gap-2 text-slate-400">
                      <MapPin className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <span className="truncate">{s.address}</span>
                    </div>
                  )}
                  {s.gstNumber && (
                    <div className="flex items-center gap-2">
                      <Package className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <Badge className="bg-slate-700 text-slate-300 text-xs px-1.5 py-0 font-mono">
                        {s.gstNumber}
                      </Badge>
                    </div>
                  )}
                </div>

                {/* Footer */}
                <div className="mt-3 pt-3 border-t border-slate-700 flex items-center justify-between">
                  <p className="text-slate-600 text-xs">
                    Added {new Date(s.createdAt).toLocaleDateString('en-IN', {
                      day: '2-digit', month: 'short', year: 'numeric'
                    })}
                  </p>
                  <Badge className="bg-teal-900/40 text-teal-400 text-xs">Active</Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="bg-slate-800 border-slate-700 text-white max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Supplier' : 'Add New Supplier'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-3 mt-2">
            <Field label="Supplier Name *">
              <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                required placeholder="Company / Distributor name" className={inputCls} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Contact Person">
                <Input value={form.contactName}
                  onChange={e => setForm({ ...form, contactName: e.target.value })}
                  placeholder="Rep name" className={inputCls} />
              </Field>
              <Field label="Phone">
                <Input value={form.phone}
                  onChange={e => setForm({ ...form, phone: e.target.value })}
                  placeholder="Mobile / Landline" className={inputCls} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Email">
                <Input type="email" value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })}
                  placeholder="email@company.com" className={inputCls} />
              </Field>
              <Field label="GST Number">
                <Input value={form.gstNumber}
                  onChange={e => setForm({ ...form, gstNumber: e.target.value })}
                  placeholder="27AAPFU0939F1ZV" className={inputCls} />
              </Field>
            </div>
            <Field label="Address">
              <Input value={form.address}
                onChange={e => setForm({ ...form, address: e.target.value })}
                placeholder="Full address with city" className={inputCls} />
            </Field>
            <Separator className="bg-slate-700" />
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="outline" onClick={() => setShowForm(false)}
                className="border-slate-600 text-slate-300 hover:bg-slate-700">Cancel</Button>
              <Button type="submit" disabled={submitting}
                className="bg-teal-600 hover:bg-teal-500 text-white">
                {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                {editing ? 'Update' : 'Add Supplier'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}